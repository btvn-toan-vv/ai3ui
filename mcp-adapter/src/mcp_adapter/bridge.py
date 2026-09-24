"""The bridge core: per-FE-session MCP runtimes and the tool-call round-trip.

Each FE session gets a :class:`SessionRuntime`: its own FastMCP instance plus
an MCP Streamable-HTTP session manager with a long-running supervisor task.
The FE's exposed tool set (``available is not False``) is mirrored onto that
FastMCP instance; any change to it fires ``notifications/tools/list_changed``
at every connected MCP client.

A ``tools/call`` from an MCP client becomes a ``tool_call`` event on the
session's SSE stream; the FE's ``call_result`` POST resolves the pending call
(with timeout and cancellation mapped per the contract).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import weakref
from typing import Any

import mcp_types as mt
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.http import FastMCPStreamableHTTPSessionManager
from fastmcp.server.middleware import Middleware, MiddlewareContext
from fastmcp.tools.base import Tool, ToolResult
from mcp.server.streamable_http import TransportSecuritySettings
from pydantic import PrivateAttr

from mcp_adapter.sessions import PendingCall, Session, SessionClosed, ToolRec, exposed_tools
from mcp_adapter.store import (
    EVENT_SESSION_CLOSED,
    EVENT_TOOL_CALL,
    EVENT_TOOL_CALL_CANCELLED,
    SessionStore,
)

logger = logging.getLogger("mcp_adapter.bridge")


class _ConnectionTracker(Middleware):
    """Captures the SDK's per-MCP-client ``Connection`` objects so the bridge
    can send out-of-band ``notifications/tools/list_changed``.

    Reaching the connection from middleware: FastMCP binds a
    ``FastMCPRequestContext`` (``fastmcp_context.request_context``) whose
    ``session`` is the SDK's per-request ``ServerSession``; that session wraps
    the ``Connection`` owning the standalone server->client channel. The
    ``_connection`` attribute is SDK-private but stable for this pinned
    version (mcp 2.2.0), and ``Connection.send_tool_list_changed()`` is
    public and best-effort (never raises, silently drops when the client has
    no standalone stream open).
    """

    def __init__(self, runtime: SessionRuntime) -> None:
        self._runtime_ref = weakref.ref(runtime)

    async def on_message(self, context: MiddlewareContext[Any], call_next: Any) -> Any:
        runtime = self._runtime_ref()
        if runtime is not None:
            with contextlib.suppress(Exception):
                fctx = context.fastmcp_context
                rc = fctx.request_context if fctx is not None else None
                conn = getattr(rc.session, "_connection", None) if rc is not None else None
                if conn is not None:
                    runtime.connections.add(conn)
        return await call_next(context)


class BridgeTool(Tool):
    """An FE-registered tool exposed over MCP. ``run`` forwards the call to the
    FE and maps the wire result onto MCP ``CallToolResult`` semantics."""

    _bridge: Bridge = PrivateAttr()
    _session_id: str = PrivateAttr()

    def __init__(self, *, bridge: Bridge, session_id: str, tool: ToolRec) -> None:
        super().__init__(name=tool.name, description=tool.description, parameters=tool.schema)
        self._bridge = bridge
        self._session_id = session_id

    async def run(self, arguments: dict[str, Any]) -> ToolResult:
        return await self._bridge.call_tool(self._session_id, self.name, arguments)


def wire_result_to_mcp(payload: dict[str, Any]) -> ToolResult:
    """Map an FE ``call_result`` payload onto a tool result.

    - ok:true  -> content=[text: message], structuredContent=data when present
    - ok:false -> isError, content=[text: message + " " + hint when present]

    Built as a raw ``CallToolResult`` and wrapped via the private
    ``_raw_mcp_result`` passthrough so ``structuredContent`` passes through
    verbatim (``ToolResult.__init__`` would reject non-dict structured
    content, while the contract forwards arbitrary ``data``).
    """
    ok = bool(payload.get("ok"))
    message = str(payload.get("message") or "")
    hint = payload.get("hint")
    if not ok and isinstance(hint, str) and hint:
        message = f"{message} {hint}"
    data = payload.get("data") if ok else None
    wire = mt.CallToolResult(
        content=[mt.TextContent(type="text", text=message)],
        isError=not ok,
    )
    if ok and data is not None:
        wire.structured_content = data
    result = ToolResult(content=wire.content, is_error=wire.is_error or False)
    result._raw_mcp_result = wire
    return result


class SessionRuntime:
    """One FastMCP server + streamable-HTTP session manager per FE session."""

    def __init__(self, bridge: Bridge, session_id: str) -> None:
        self.bridge = bridge
        self.session_id = session_id
        self.registered: dict[str, ToolRec] = {}  # currently exposed on MCP
        self.connections: weakref.WeakSet[Any] = weakref.WeakSet()  # SDK Connections

        self.server = FastMCP(name=f"mcp-adapter:{session_id}", on_duplicate="replace")
        self.server.add_middleware(_ConnectionTracker(self))
        self.manager = FastMCPStreamableHTTPSessionManager(
            app=self.server._mcp_server,
            json_response=False,  # SSE streams (spec default; supports out-of-band notifications)
            stateless=False,
            security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=False),
            session_idle_timeout=None,  # the FE-session reaper owns lifetime
        )
        self._stop = asyncio.Event()
        self._started = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        # anyio task groups must enter/exit in the same task, so the manager's
        # run() gets its own supervisor task rather than being entered inline.
        self._task = asyncio.create_task(self._run(), name=f"mcp-runtime-{self.session_id}")
        await self._started.wait()

    async def _run(self) -> None:
        try:
            async with self.manager.run():
                self._started.set()
                await self._stop.wait()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("MCP runtime crashed for session %s", self.session_id)
        finally:
            self._started.set()

    async def stop(self) -> None:
        self._stop.set()
        task = self._task
        if task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=10)
            except (TimeoutError, asyncio.CancelledError):
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    # -- tool set mirroring --------------------------------------------------

    async def sync_tools(self, session: Session) -> bool:
        """Mirror ``session``'s exposed set onto the FastMCP instance.

        Masking is enforced server-side, twice, at this layer: masked tools
        are never registered (so absent from tools/list), and
        :meth:`Bridge.call_tool` re-checks exposure at execution time.
        Returns True when the exposed set changed.
        """
        exposed = exposed_tools(session)
        changed = False
        for name in list(self.registered):
            if name not in exposed:
                with contextlib.suppress(KeyError):
                    self.server._local_provider.remove_tool(name)
                changed = True
        for name, tool in exposed.items():
            prev = self.registered.get(name)
            if (
                prev is None
                or prev.description != tool.description
                or prev.schema != tool.schema
                or prev.available != tool.available
            ):
                self.server.add_tool(BridgeTool(bridge=self.bridge, session_id=session.id, tool=tool))
                changed = True
        self.registered = dict(exposed)
        return changed

    async def notify_tools_changed(self) -> None:
        """Best-effort ``notifications/tools/list_changed`` to all MCP clients."""
        for conn in list(self.connections):
            with contextlib.suppress(Exception):
                await conn.send_tool_list_changed()


class Bridge:
    """Owns the store and all per-session MCP runtimes."""

    def __init__(self, store: SessionStore, call_timeout: float, grace_seconds: float) -> None:
        self.store = store
        self.call_timeout = call_timeout
        self.grace_seconds = grace_seconds
        self.runtimes: dict[str, SessionRuntime] = {}
        self._runtime_lock = asyncio.Lock()

    async def ensure_runtime(self, session_id: str) -> SessionRuntime | None:
        """Get or lazily create the MCP runtime; None if the session is gone."""
        runtime = self.runtimes.get(session_id)
        if runtime is not None:
            return runtime
        session = await self.store.get(session_id)
        if session is None:
            return None
        async with self._runtime_lock:
            runtime = self.runtimes.get(session_id)
            if runtime is None:
                runtime = SessionRuntime(self, session_id)
                await runtime.start()
                await runtime.sync_tools(session)
                self.runtimes[session_id] = runtime
        return runtime

    async def sync_and_notify(self, session: Session) -> None:
        runtime = self.runtimes.get(session.id)
        if runtime is None:
            return
        if await runtime.sync_tools(session):
            await runtime.notify_tools_changed()

    async def teardown(self, session_id: str) -> None:
        """Fail pending calls, close streams, delete state, stop the runtime."""
        runtime = self.runtimes.pop(session_id, None)
        await self.store.fail_all_pending(session_id, SessionClosed("session closed"))
        with contextlib.suppress(Exception):
            await self.store.publish_event(session_id, {"event": EVENT_SESSION_CLOSED, "data": {}})
        await self.store.delete(session_id)
        if runtime is not None:
            await runtime.stop()

    async def shutdown(self) -> None:
        for session_id in list(self.runtimes):
            await self.teardown(session_id)

    # -- tool call round-trip -------------------------------------------------

    async def call_tool(self, session_id: str, name: str, arguments: dict[str, Any]) -> ToolResult:
        session = await self.store.get(session_id)
        if session is None:
            raise ToolError("session expired")

        # Second masking enforcement: refuse masked/unknown names even if the
        # FastMCP registry somehow went stale.
        tool = session.tools.get(name)
        if tool is None or tool.available is False:
            raise ToolError(f"Unknown tool: {name!r}")

        pending = await self.store.new_pending(session_id, name, arguments)
        if pending is None:
            raise ToolError("session expired")

        await self.store.publish_event(
            session_id,
            {
                "event": EVENT_TOOL_CALL,
                "data": {"callId": pending.call_id, "name": name, "args": arguments},
            },
        )
        try:
            payload = await self.store.await_call(pending, self.call_timeout)
        except TimeoutError:
            await self.store.drop_pending(session_id, pending.call_id)
            return wire_result_to_mcp(
                {"ok": False, "message": f"tool call timed out after {self.call_timeout:g}s"}
            )
        except SessionClosed as exc:
            return wire_result_to_mcp({"ok": False, "message": str(exc) or "session closed"})
        except asyncio.CancelledError:
            # MCP client cancelled (notifications/cancelled) or disconnected.
            await self.store.drop_pending(session_id, pending.call_id)
            with contextlib.suppress(Exception):
                await self.store.publish_event(
                    session_id,
                    {"event": EVENT_TOOL_CALL_CANCELLED, "data": {"callId": pending.call_id}},
                )
            raise
        return wire_result_to_mcp(payload)
