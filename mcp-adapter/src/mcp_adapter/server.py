"""HTTP layer: the FE session channel (SSE + messages) and per-session MCP
endpoints, assembled into one Starlette ASGI app.

Wire contract (docs/plan.md):

    GET    /sessions                     -> SSE; first frame `event: session`
    GET    /sessions/{id}/stream         -> reattach SSE (404 if dead)
    POST   /sessions/{id}/messages       -> FE->adapter messages
    DELETE /sessions/{id}                -> close session
    ANY    /{id}/mcp                     -> MCP Streamable HTTP (per session)

Config via environment:
    SESSION_GRACE_SECONDS  (default 60)  reconnect grace / session TTL
    CALL_TIMEOUT_SECONDS   (default 60)  tool-call round-trip timeout
    REDIS_URL              (unset)       enables RedisSessionStore

Binding/port come from uvicorn flags, e.g.:
    uv run uvicorn --factory mcp_adapter.server:create_app \
        --host 127.0.0.1 --port 8123
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.metadata
import json
import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastmcp_docs.config import FastMCPDocsConfig
from fastmcp_docs.extractor import ToolExtractor
from fastmcp_docs.templates import get_default_favicon_svg, get_docs_ui_template
from starlette.applications import Starlette
from starlette.middleware import Middleware as StarletteMiddleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from mcp_adapter.bridge import Bridge
from mcp_adapter.sessions import REGISTRY_MESSAGE_TYPES, validate_message
from mcp_adapter.store import (
    EVENT_SESSION_CLOSED,
    EVENT_TOOL_CALL,
    EVENT_TOOL_CALL_CANCELLED,
    InMemorySessionStore,
    RedisSessionStore,
    SessionStore,
)

logger = logging.getLogger("mcp_adapter.server")

SSE_KEEPALIVE_SECONDS = 25.0  # `:ping` comment cadence
REAPER_INTERVAL_SECONDS = 10.0

# Event names forwarded to the FE over the session SSE stream.
_FORWARDED_EVENTS = frozenset({EVENT_TOOL_CALL, EVENT_TOOL_CALL_CANCELLED})


def _sse_frame(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


def _mcp_url_headers(headers: list[tuple[bytes, bytes]], scope: Scope, session_id: str) -> str:
    """Absolute MCP URL from raw ASGI headers, honoring X-Forwarded-Proto/Host."""
    hdrs = {k.decode().lower(): v.decode() for k, v in headers}
    proto = (hdrs.get("x-forwarded-proto") or scope.get("scheme", "http")).split(",")[0].strip()
    host = (hdrs.get("x-forwarded-host") or hdrs.get("host") or "localhost").split(",")[0].strip()
    return f"{proto}://{host}/{session_id}/mcp"


class SessionSSE:
    """Raw-ASGI Server-Sent-Events endpoint for the FE session stream.

    Deliberately NOT a Starlette ``StreamingResponse``: that generator ran
    inside Starlette's response task-group, and under concurrent MCP request
    traffic it was poisoned by sibling scope cancels — the FE stream died
    mid-session (uvicorn ran ``RequestResponseCycle`` cancellation through
    our pending ``handle.get()``). Talked straight to ``send``/``receive``,
    our task is exactly the request task; nothing else scopes it.

    ``create=True`` == ``GET /sessions``: mints the session (and its MCP
    runtime) before the handshake frame. ``create=False`` == the reattach
    route: same stream for an existing id, 404 when gone.
    """

    def __init__(self, *, create: bool) -> None:
        self.create = create

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        assert scope["type"] == "http"
        bridge: Bridge = scope["app"].state.bridge
        store = bridge.store

        if self.create:
            session = await store.create()
            runtime = await bridge.ensure_runtime(session.id)
            if runtime is None:  # pragma: no cover - creation just succeeded
                await self._plain(send, 500, b'{"detail":"could not create session"}')
                return
            session_id = session.id
            logger.info("session created: %s", session_id)
        else:
            session_id = scope["path_params"]["session_id"]
            if await store.get(session_id) is None:
                await self._plain(send, 404, b'{"detail":"session not found"}')
                return

        handle = await store.attach_stream(session_id)
        if handle is None:
            await self._plain(send, 404, b'{"detail":"session not found"}')
            return

        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"text/event-stream; charset=utf-8"),
                    (b"cache-control", b"no-cache"),
                    (b"x-accel-buffering", b"no"),  # defeat proxy buffering
                ],
            }
        )

        async def emit(text: str) -> bool:
            try:
                await send({"type": "http.response.body", "body": text.encode(), "more_body": True})
                return True
            except (OSError, RuntimeError):
                return False  # client vanished mid-write

        async def wait_disconnect() -> None:
            # First message is the (empty) request body; only afterwards does
            # http.disconnect become meaningful. This task intentionally never
            # returns on any other message.
            first = await receive()
            if first["type"] == "http.request" and first.get("more_body"):
                await receive()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return

        watcher = asyncio.create_task(wait_disconnect())
        try:
            payload = {
                "id": session_id,
                "mcpUrl": _mcp_url_headers(scope["headers"], scope, session_id),
                "postUrl": f"/sessions/{session_id}/messages",
                "docsUrl": f"{_public_origin(scope)}/{session_id}/docs",
            }
            if not await emit(_sse_frame("session", payload)):
                return
            while True:
                waiter = asyncio.ensure_future(handle.get())
                done, _pending = await asyncio.wait(
                    {waiter, watcher},
                    timeout=SSE_KEEPALIVE_SECONDS,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if waiter not in done:
                    waiter.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await waiter
                if watcher in done:  # http.disconnect (task never completes otherwise)
                    logger.warning("DBG client disconnect sid=%s", session_id)
                    break
                if waiter in done:
                    event = waiter.result()
                    if event is None:
                        break  # superseded by another stream / closed
                    name = event.get("event")
                    if name in _FORWARDED_EVENTS:
                        logger.warning("DBG emit event=%s sid=%s", name, session_id)
                        if not await emit(_sse_frame(name, event.get("data") or {})):
                            logger.warning("DBG emit FAILED sid=%s", session_id)
                            break
                    elif name == EVENT_SESSION_CLOSED:
                        break
                    # other internal events (e.g. call_result on the Redis bus)
                    # are not part of the FE-facing stream.
                    continue
                # Neither finished: keepalive.
                if not await emit(":ping\n\n"):
                    break
                with contextlib.suppress(Exception):
                    await store.stream_heartbeat(session_id)
        finally:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher
            with contextlib.suppress(Exception):
                await send({"type": "http.response.body", "body": b"", "more_body": False})
            with contextlib.suppress(Exception):
                await store.detach_stream(session_id, handle)

    @staticmethod
    async def _plain(send: Send, status: int, body: bytes) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": body})


async def messages_endpoint(request: Request) -> Response:
    """POST /sessions/{id}/messages — FE -> adapter."""
    bridge: Bridge = request.app.state.bridge
    store = bridge.store
    session_id = request.path_params["session_id"]

    try:
        msg = await request.json()
    except Exception:  # noqa: BLE001 - any JSON decode failure is a 400
        return JSONResponse({"detail": "malformed JSON"}, status_code=400)

    error = validate_message(msg)
    if error is not None:
        return JSONResponse({"detail": error}, status_code=400)

    session = await store.get(session_id)
    if session is None:
        return JSONResponse({"detail": "session not found"}, status_code=404)
    await store.touch(session_id)

    mtype = msg["type"]
    if mtype in REGISTRY_MESSAGE_TYPES:
        outcome = await store.apply_message(session_id, msg)
        if outcome is None:  # expired in a race
            return JSONResponse({"detail": "session not found"}, status_code=404)
        if outcome.applied and (outcome.exposed_changed or outcome.context_changed):
            # Store mutation is complete; sync the MCP surface before 200 so
            # the FE can rely on read-after-write. context_changed covers the
            # get_ui_context built-in: its description embeds the slice
            # catalogue, so a key/description change re-renders it and the
            # re-registration is what emits tools/list_changed.
            fresh = await store.get(session_id)
            if fresh is not None:
                with contextlib.suppress(Exception):
                    await bridge.sync_and_notify(fresh)
        return JSONResponse({"ok": True})

    if mtype == "call_result":
        payload: dict[str, Any] = {"ok": msg["ok"], "message": msg.get("message")}
        if "data" in msg:
            payload["data"] = msg["data"]
        if "hint" in msg:
            payload["hint"] = msg["hint"]
        await store.resolve_call(session_id, msg["callId"], payload)
        return JSONResponse({"ok": True})

    if mtype == "session.close":
        await bridge.teardown(session_id)
        return JSONResponse({"ok": True})

    # validate_message rejects unknown types; unreachable
    return JSONResponse({"detail": "unknown message type"}, status_code=400)  # pragma: no cover


async def delete_session_endpoint(request: Request) -> Response:
    """DELETE /sessions/{id} — explicit close."""
    bridge: Bridge = request.app.state.bridge
    session_id = request.path_params["session_id"]
    if await bridge.store.get(session_id) is None:
        return JSONResponse({"detail": "session not found"}, status_code=404)
    await bridge.teardown(session_id)
    logger.info("session closed: %s", session_id)
    return JSONResponse({"ok": True})


def _public_origin(scope: Scope) -> str:
    """Scheme://host as the outside world reaches us (X-Forwarded aware)."""
    hdrs = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
    proto = (hdrs.get("x-forwarded-proto") or scope.get("scheme", "http")).split(",")[0].strip()
    host = (hdrs.get("x-forwarded-host") or hdrs.get("host") or "localhost").split(",")[0].strip()
    return f"{proto}://{host}"


async def session_docs_api(request: Request) -> Response:
    """GET /{id}[/mcp]/api/tools — fastmcp-docs feed extracted live from the
    session's FastMCP instance; masked tools never appear here."""
    bridge: Bridge = request.app.state.bridge
    session_id = request.path_params["session_id"]
    runtime = await bridge.ensure_runtime(session_id)
    if runtime is None:
        return JSONResponse({"detail": "session not found"}, status_code=404)
    registry = await ToolExtractor(verbose=False).extract_tools(runtime.server)
    return JSONResponse(
        {
            "server": f"mcp-adapter:{session_id}",
            "total_tools": len(registry),
            "tools": registry,
        }
    )


def _docs_prefix(path: str) -> str:
    """Which mount the docs were served from: ``/{id}`` or ``/{id}/mcp`` —
    the page's API fetch must stay under the same prefix."""
    return path.rsplit("/docs", 1)[0]


async def session_docs_page(request: Request) -> Response:
    """GET /{id}[/mcp]/docs — human-facing Swagger-style page for the session."""
    bridge: Bridge = request.app.state.bridge
    session_id = request.path_params["session_id"]
    runtime = await bridge.ensure_runtime(session_id)
    if runtime is None:
        return JSONResponse({"detail": "session not found"}, status_code=404)
    origin = _public_origin(request.scope)
    prefix = _docs_prefix(request.url.path)  # /{id} or /{id}/mcp, as linked
    mcp_url = f"{origin}/{session_id}/mcp"
    try:
        version = importlib.metadata.version("mcp-adapter")
    except importlib.metadata.PackageNotFoundError:  # pragma: no cover - src runs only
        version = "0.1.0"
    config = FastMCPDocsConfig(
        title=f"MCP session {session_id}",
        version=version,
        description=(
            "Live tools of the frontend attached to this session. Read and call "
            f"them over MCP at {mcp_url} — masked tools never "
            "show up here, and the list updates the moment the frontend's "
            "registry changes (tools.list_changed)."
        ),
        base_url=origin,
        api_tools_route=f"{prefix}/api/tools",
        favicon_url=f"{prefix}/favicon.svg",
        openapi_servers=[{"url": origin, "description": "mcp-adapter"}],
        verbose=False,
    )
    return HTMLResponse(get_docs_ui_template(config))


async def session_docs_favicon(request: Request) -> Response:
    """GET /{id}/favicon.svg — the package's default, under the session prefix."""
    del request
    return Response(
        content=get_default_favicon_svg(),
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=86400"},
    )


class MCPDispatch:
    """ASGI endpoint routing ``/{id}/mcp`` to that session's MCP runtime.

    Route endpoints that aren't request/response functions are mounted by
    Starlette as raw ASGI callables, which is what the SDK's session manager
    speaks.
    """

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        bridge: Bridge = scope["app"].state.bridge
        session_id = scope["path_params"]["session_id"]
        runtime = await bridge.ensure_runtime(session_id)
        if runtime is None:
            response: Response = JSONResponse({"detail": "session not found"}, status_code=404)
            await response(scope, receive, send)
            return
        await runtime.manager.handle_request(scope, receive, send)


async def _reaper(app: Starlette) -> None:
    """Expire sessions with no active stream past the grace period."""
    bridge: Bridge = app.state.bridge
    store = bridge.store
    while True:
        await asyncio.sleep(REAPER_INTERVAL_SECONDS)
        try:
            for session_id in list(bridge.runtimes):
                session = await store.get(session_id)
                active = await store.stream_active(session_id)
                if session is None or (
                    not active and time.time() - session.last_seen > bridge.grace_seconds
                ):
                    logger.info("reaping session %s (stream active=%s)", session_id, active)
                    await bridge.teardown(session_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("reaper iteration failed")


@asynccontextmanager
async def _lifespan(app: Starlette) -> AsyncIterator[None]:
    reaper = asyncio.create_task(_reaper(app), name="session-reaper")
    try:
        yield
    finally:
        reaper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await reaper
        bridge: Bridge = app.state.bridge
        await bridge.shutdown()
        await bridge.store.close()


def create_store() -> SessionStore:
    redis_url = os.environ.get("REDIS_URL")
    grace = float(os.environ.get("SESSION_GRACE_SECONDS", "60"))
    call_timeout = float(os.environ.get("CALL_TIMEOUT_SECONDS", "60"))
    if redis_url:
        import redis
        import redis.asyncio as aioredis

        try:
            # Probe before committing: redis runs on its own compose profile,
            # so a profile-less `up` lands here with REDIS_URL set but Redis
            # down (or DNS-unresolvable). Degrade, don't crash.
            redis.from_url(redis_url, socket_connect_timeout=2).ping()
        except Exception as exc:  # noqa: BLE001 - probe failure means "no redis"
            logger.error(
                "redis at %s unreachable (%s) — falling back to InMemorySessionStore",
                redis_url,
                exc,
            )
        else:
            client = aioredis.from_url(redis_url, decode_responses=True)
            logger.info("using RedisSessionStore (%s)", redis_url)
            return RedisSessionStore(client, grace_seconds=grace, call_timeout=call_timeout)
    logger.info("using InMemorySessionStore")
    return InMemorySessionStore(grace_seconds=grace)


def create_app() -> Starlette:
    # .upper(): env values are case-insensitive by convention, logging is not.
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())

    grace = float(os.environ.get("SESSION_GRACE_SECONDS", "60"))
    call_timeout = float(os.environ.get("CALL_TIMEOUT_SECONDS", "60"))
    store = create_store()
    bridge = Bridge(store, call_timeout=call_timeout, grace_seconds=grace)

    routes = [
        Route("/sessions", endpoint=SessionSSE(create=True), methods=["GET"]),
        Route("/sessions/{session_id}/stream", endpoint=SessionSSE(create=False), methods=["GET"]),
        Route("/sessions/{session_id}/messages", endpoint=messages_endpoint, methods=["POST"]),
        Route("/sessions/{session_id}", endpoint=delete_session_endpoint, methods=["DELETE"]),
        Route("/{session_id}/mcp", endpoint=MCPDispatch(), methods=["GET", "POST", "DELETE"]),
        Route("/{session_id}/docs", endpoint=session_docs_page, methods=["GET"]),
        Route("/{session_id}/mcp/docs", endpoint=session_docs_page, methods=["GET"]),
        Route("/{session_id}/api/tools", endpoint=session_docs_api, methods=["GET"]),
        Route("/{session_id}/mcp/api/tools", endpoint=session_docs_api, methods=["GET"]),
        Route("/{session_id}/favicon.svg", endpoint=session_docs_favicon, methods=["GET"]),
        Route("/{session_id}/mcp/favicon.svg", endpoint=session_docs_favicon, methods=["GET"]),
    ]

    app = Starlette(
        routes=routes,
        middleware=[
            # The FE runs on a different origin in any real deployment; the
            # session id itself is the bearer credential (plan §8). Tighten to
            # an allowlist when deploying if desired.
            StarletteMiddleware(
                CORSMiddleware,
                allow_origins=["*"],
                allow_methods=["*"],
                allow_headers=["*"],
                expose_headers=["*"],
            )
        ],
        lifespan=_lifespan,
    )
    app.state.store = store
    app.state.bridge = bridge
    return app


# For `uvicorn mcp_adapter.server:app` (env is read at call time, so either
# entry point honors the same configuration).
app = create_app()
