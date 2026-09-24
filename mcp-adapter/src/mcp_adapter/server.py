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
import json
import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from starlette.applications import Starlette
from starlette.middleware import Middleware as StarletteMiddleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
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


def _mcp_url(request: Request, session_id: str) -> str:
    """Absolute MCP URL, honoring X-Forwarded-Proto/Host behind proxies."""
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme).split(",")[0].strip()
    host = (request.headers.get("x-forwarded-host") or request.url.netloc).split(",")[0].strip()
    return f"{proto}://{host}/{session_id}/mcp"


def _session_payload(request: Request, session_id: str) -> dict[str, Any]:
    return {
        "id": session_id,
        "mcpUrl": _mcp_url(request, session_id),
        "postUrl": f"/sessions/{session_id}/messages",
    }


async def _session_sse(request: Request, session_id: str) -> Response:
    """Shared SSE implementation for session create and reattach."""
    bridge: Bridge = request.app.state.bridge
    store = bridge.store

    handle = await store.attach_stream(session_id)
    if handle is None:
        return JSONResponse({"detail": "session not found"}, status_code=404)

    async def stream() -> AsyncIterator[str]:
        try:
            yield _sse_frame("session", _session_payload(request, session_id))
            while True:
                try:
                    event = await asyncio.wait_for(handle.get(), timeout=SSE_KEEPALIVE_SECONDS)
                except TimeoutError:
                    yield ":ping\n\n"
                    with contextlib.suppress(Exception):
                        await store.stream_heartbeat(session_id)
                    continue
                if event is None:
                    break  # superseded by another stream / closed
                name = event.get("event")
                if name in _FORWARDED_EVENTS:
                    yield _sse_frame(name, event.get("data") or {})
                elif name == EVENT_SESSION_CLOSED:
                    break
                # other internal events (e.g. call_result on the Redis bus)
                # are not part of the FE-facing stream.
        finally:
            with contextlib.suppress(Exception):
                await store.detach_stream(session_id, handle)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # defeat proxy buffering
        },
    )


async def create_session_endpoint(request: Request) -> Response:
    """GET /sessions — the FE handshake."""
    bridge: Bridge = request.app.state.bridge
    session = await bridge.store.create()
    # Bring the MCP runtime up before the handshake completes so mcpUrl is
    # usable the moment the FE receives it.
    runtime = await bridge.ensure_runtime(session.id)
    if runtime is None:  # pragma: no cover - creation just succeeded
        return JSONResponse({"detail": "could not create session"}, status_code=500)
    logger.info("session created: %s", session.id)
    return await _session_sse(request, session.id)


async def stream_session_endpoint(request: Request) -> Response:
    """GET /sessions/{id}/stream — reattach to a live session."""
    session_id = request.path_params["session_id"]
    if await request.app.state.bridge.store.get(session_id) is None:
        return JSONResponse({"detail": "session not found"}, status_code=404)
    return await _session_sse(request, session_id)


async def messages_endpoint(request: Request) -> Response:
    """POST /sessions/{id}/messages — FE -> adapter."""
    bridge: Bridge = request.app.state.bridge
    store = bridge.store
    session_id = request.path_params["session_id"]

    try:
        msg = await request.json()
    except Exception:
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
        if outcome.applied and outcome.exposed_changed:
            # Store mutation is complete; sync the MCP surface before 200 so
            # the FE can rely on read-after-write.
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
                    not active
                    and time.time() - session.last_seen > bridge.grace_seconds
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
        import redis.asyncio as aioredis

        client = aioredis.from_url(redis_url, decode_responses=True)
        logger.info("using RedisSessionStore (%s)", redis_url)
        return RedisSessionStore(client, grace_seconds=grace, call_timeout=call_timeout)
    logger.info("using InMemorySessionStore")
    return InMemorySessionStore(grace_seconds=grace)


def create_app() -> Starlette:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

    grace = float(os.environ.get("SESSION_GRACE_SECONDS", "60"))
    call_timeout = float(os.environ.get("CALL_TIMEOUT_SECONDS", "60"))
    store = create_store()
    bridge = Bridge(store, call_timeout=call_timeout, grace_seconds=grace)

    routes = [
        Route("/sessions", endpoint=create_session_endpoint, methods=["GET"]),
        Route("/sessions/{session_id}/stream", endpoint=stream_session_endpoint, methods=["GET"]),
        Route("/sessions/{session_id}/messages", endpoint=messages_endpoint, methods=["POST"]),
        Route("/sessions/{session_id}", endpoint=delete_session_endpoint, methods=["DELETE"]),
        Route("/{session_id}/mcp", endpoint=MCPDispatch(), methods=["GET", "POST", "DELETE"]),
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
