"""Session stores.

``SessionStore`` is the seam for horizontal scaling (plan §7):

- :class:`InMemorySessionStore` — default. Per-session ``asyncio.Queue``
  feeding the one active SSE stream, per-session pending-call futures,
  ``last_seen`` timestamps. Single node.
- :class:`RedisSessionStore` — selected when ``REDIS_URL`` is set. Sessions
  and registries live in Redis hashes with a TTL refreshed on activity,
  pending calls in Redis keys with TTL, and every session has a pub/sub
  channel ``sess:{id}:events`` so an FE POST landing on node B reaches the
  SSE stream held by node A (and a ``call_result`` posted to node B reaches
  the node holding the MCP client request).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from typing import Any, Protocol

from mcp_adapter.sessions import (
    ApplyOutcome,
    PendingCall,
    Session,
    SessionClosed,
    apply_message,
    new_call_id,
    new_session_id,
)

logger = logging.getLogger("mcp_adapter.store")

# SSE-frame-neutral internal event envelope: {"event": <name>, "data": <dict>}
EVENT_TOOL_CALL = "tool_call"
EVENT_TOOL_CALL_CANCELLED = "tool_call_cancelled"
EVENT_SESSION_CLOSED = "session_closed"
EVENT_CALL_RESULT = "call_result"  # internal (cross-node result routing)


class StreamHandle(Protocol):
    """One attached SSE consumer. ``get()`` returns the next event dict, or
    None when this handle was superseded/closed (consumer must exit)."""

    async def get(self) -> dict[str, Any] | None: ...


class SessionStore(Protocol):
    """Storage contract used by :mod:`mcp_adapter.bridge` and the HTTP layer."""

    # sessions
    async def create(self) -> Session: ...
    async def get(self, session_id: str) -> Session | None: ...
    async def touch(self, session_id: str) -> None: ...
    async def delete(self, session_id: str) -> None: ...
    async def apply_message(self, session_id: str, msg: dict[str, Any]) -> ApplyOutcome | None:
        """Apply a validated registry message; None => unknown/expired session."""
        ...

    # session event stream (server -> FE)
    async def attach_stream(self, session_id: str) -> StreamHandle | None: ...
    async def detach_stream(self, session_id: str, handle: StreamHandle) -> None: ...
    async def stream_active(self, session_id: str) -> bool: ...
    async def stream_heartbeat(self, session_id: str) -> None:
        """Refresh stream liveness + session activity (called on keepalives)."""
        ...
    async def publish_event(self, session_id: str, event: dict[str, Any]) -> None: ...

    # pending tool calls
    async def new_pending(self, session_id: str, name: str, args: dict[str, Any]) -> PendingCall | None: ...
    async def await_call(self, pending: PendingCall, timeout: float) -> dict[str, Any]:
        """Resolve with the FE's call_result payload.

        Raises TimeoutError on timeout, SessionClosed if the session died, and
        lets asyncio.CancelledError propagate (MCP client cancellation).
        """
        ...

    async def drop_pending(self, session_id: str, call_id: str) -> None: ...
    async def resolve_call(self, session_id: str, call_id: str, payload: dict[str, Any]) -> bool: ...
    async def fail_all_pending(self, session_id: str, exc: Exception) -> None: ...

    async def close(self) -> None: ...


# ---------------------------------------------------------------------------
# In-memory implementation
# ---------------------------------------------------------------------------


class _MemStreamHandle:
    __slots__ = ("queue", "token")

    def __init__(self, token: int) -> None:
        self.queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self.token = token

    async def get(self) -> dict[str, Any] | None:
        return await self.queue.get()


class InMemorySessionStore:
    """Default single-node store. Locking: a single event loop plus the fact
    that registry mutations never span awaits is sufficient."""

    def __init__(self, grace_seconds: float) -> None:
        self.grace_seconds = grace_seconds
        self.sessions: dict[str, Session] = {}
        self._handles: dict[str, _MemStreamHandle] = {}
        self._pending: dict[str, PendingCall] = {}  # call_id -> PendingCall
        self._futures: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._stream_seq = 0

    # -- sessions -----------------------------------------------------------

    async def create(self) -> Session:
        session = Session(id=new_session_id())
        self.sessions[session.id] = session
        return session

    async def get(self, session_id: str) -> Session | None:
        return self.sessions.get(session_id)

    async def touch(self, session_id: str) -> None:
        session = self.sessions.get(session_id)
        if session is not None:
            session.touch()

    async def delete(self, session_id: str) -> None:
        self.sessions.pop(session_id, None)
        handle = self._handles.pop(session_id, None)
        if handle is not None:
            with contextlib.suppress(asyncio.QueueFull):
                handle.queue.put_nowait(None)

    async def apply_message(self, session_id: str, msg: dict[str, Any]) -> ApplyOutcome | None:
        session = self.sessions.get(session_id)
        if session is None:
            return None
        return apply_message(session, msg)

    # -- streams ------------------------------------------------------------

    async def attach_stream(self, session_id: str) -> StreamHandle | None:
        session = self.sessions.get(session_id)
        if session is None:
            return None
        session.touch()
        # One active stream per session: supersede any previous holder.
        old = self._handles.get(session_id)
        if old is not None:
            with contextlib.suppress(asyncio.QueueFull):
                old.queue.put_nowait(None)
        self._stream_seq += 1
        handle = _MemStreamHandle(self._stream_seq)
        self._handles[session_id] = handle
        return handle

    async def detach_stream(self, session_id: str, handle: StreamHandle) -> None:
        if isinstance(handle, _MemStreamHandle) and self._handles.get(session_id) is handle:
            self._handles.pop(session_id, None)

    async def stream_active(self, session_id: str) -> bool:
        return session_id in self._handles

    async def stream_heartbeat(self, session_id: str) -> None:
        await self.touch(session_id)

    async def publish_event(self, session_id: str, event: dict[str, Any]) -> None:
        handle = self._handles.get(session_id)
        if handle is not None:
            with contextlib.suppress(asyncio.QueueFull):
                handle.queue.put_nowait(event)

    # -- pending calls ------------------------------------------------------

    async def new_pending(self, session_id: str, name: str, args: dict[str, Any]) -> PendingCall | None:
        if session_id not in self.sessions:
            return None
        pending = PendingCall(call_id=new_call_id(), session_id=session_id, name=name, args=args)
        loop = asyncio.get_running_loop()
        self._pending[pending.call_id] = pending
        self._futures[pending.call_id] = loop.create_future()
        return pending

    async def await_call(self, pending: PendingCall, timeout: float) -> dict[str, Any]:
        fut = self._futures.get(pending.call_id)
        if fut is None:
            raise SessionClosed("pending call unknown")
        async with asyncio.timeout(timeout):
            return await fut

    async def drop_pending(self, session_id: str, call_id: str) -> None:
        self._pending.pop(call_id, None)
        fut = self._futures.pop(call_id, None)
        if fut is not None and not fut.done():
            fut.cancel()

    async def resolve_call(self, session_id: str, call_id: str, payload: dict[str, Any]) -> bool:
        self._pending.pop(call_id, None)
        fut = self._futures.pop(call_id, None)
        if fut is None:
            return False
        if not fut.done():
            fut.set_result(payload)
        return True

    async def fail_all_pending(self, session_id: str, exc: Exception) -> None:
        for call_id, pending in list(self._pending.items()):
            if pending.session_id != session_id:
                continue
            self._pending.pop(call_id, None)
            fut = self._futures.pop(call_id, None)
            if fut is not None and not fut.done():
                fut.set_exception(exc)

    async def close(self) -> None:  # nothing to release
        return None


# ---------------------------------------------------------------------------
# Redis implementation
# ---------------------------------------------------------------------------

# VALIDATION:
#   Single-node + Redis is covered by compose: `docker compose up -d` at the
#   repo root wires REDIS_URL to the bundled redis service, and
#   `uv run scripts/smoke.py 8123` passes 19/19 against that stack.
#   Result delivery is race-safe: subscribers wait for the pump's server-side
#   SUBSCRIBE before returning, and call_result payloads land in a durable
#   TTL'd key (scall:{id}:result) the awaiter checks after subscribing — an
#   event published before the subscription landed is never lost to pub/sub's
#   fire-and-forget delivery.
#
#   MULTI-NODE (manual, unautomated):
#   1. docker run -p 6379:6379 redis:8-alpine
#   2. REDIS_URL=redis://127.0.0.1:6379/0 uv run uvicorn \
#          --factory mcp_adapter.server:create_app --port 8123   (node A)
#   3. Same command with --port 8124                              (node B)
#   4. Create a session against A (GET http://127.0.0.1:8123/sessions), keep
#      the SSE stream open.
#   5. POST the registry snapshot to node B
#      (/sessions/{id}/messages on :8124) and verify the MCP tool list on
#      either node's /{id}/mcp reflects it; call the tool against B and POST
#      the call_result to A — the pending call must resolve via the
#      sess:{id}:events channel.
#   6. Kill A: node's SSE dies; after SESSION_GRACE_SECONDS the session hash
#      expires on its own (TTL), and B's reaper tears down any local runtime.
#
# Known multi-node limitations (documented, acceptable for v1):
#  - registry apply uses a short-lived advisory lock; two post-with-lock-
#    timeout collisions could interleave, but revision check (inside the
#    lock) keeps the applied state monotonic in practice.
#  - tool_call events published while no SSE stream is attached anywhere are
#    dropped; the call hits CALL_TIMEOUT_SECONDS like a hung FE would.


def _session_key(sid: str) -> str:
    return f"sess:{sid}"


def _stream_key(sid: str) -> str:
    return f"sess:{sid}:stream"


def _events_channel(sid: str) -> str:
    return f"sess:{sid}:events"


def _call_key(call_id: str) -> str:
    return f"scall:{call_id}"


def _result_key(call_id: str) -> str:
    # Durable home for a call_result. Redis pub/sub is fire-and-forget: an
    # event published before a subscriber's SUBSCRIBE lands is lost, so the
    # payload must live in a key the awaiter can read after subscribing.
    return f"scall:{call_id}:result"


def _lock_key(sid: str) -> str:
    return f"lock:sess:{sid}"


def _dump_session(session: Session) -> dict[str, str]:
    d = session.to_dict()
    return {
        "id": d["id"],
        "created_at": repr(d["created_at"]),
        "last_seen": repr(d["last_seen"]),
        "revision": str(d["revision"]),
        "tools": json.dumps(d["tools"]),
        "context": json.dumps(d["context"]),
        "pending_masks": json.dumps(d["pending_masks"]),
    }


class _LocalBus:
    """Per-node fan-out of Redis pub/sub channels to local async queues.

    One pub/sub connection + pump task per (node, session); both the SSE
    stream holder and in-flight tool-call waiters subscribe locally. Any node
    (including this one) reaches the channel by PUBLISHing.
    """

    def __init__(self, redis: Any) -> None:
        self._redis = redis
        # session_id -> (pump task, subscriber queues, subscribed server-side)
        self._pumps: dict[str, tuple[asyncio.Task[None], set[asyncio.Queue[dict[str, Any] | None]], asyncio.Event]] = {}

    async def subscribe(self, session_id: str) -> asyncio.Queue[dict[str, Any] | None]:
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        entry = self._pumps.get(session_id)
        if entry is None:
            ready = asyncio.Event()
            task = asyncio.create_task(self._pump(session_id, ready), name=f"bus-{session_id}")
            entry = (task, set(), ready)
            self._pumps[session_id] = entry
        entry[1].add(queue)
        # Only return once the pump's SUBSCRIBE has been confirmed by Redis;
        # pub/sub drops messages published before that, and callers publish
        # immediately after subscribing (tool_call -> await_call).
        await entry[2].wait()
        return queue

    async def unsubscribe(self, session_id: str, queue: asyncio.Queue[dict[str, Any] | None]) -> None:
        entry = self._pumps.get(session_id)
        if entry is None:
            return
        task, subs, _ready = entry
        subs.discard(queue)
        if not subs:
            self._pumps.pop(session_id, None)
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _pump(self, session_id: str, ready: asyncio.Event) -> None:
        pubsub = self._redis.pubsub()
        subs: set[asyncio.Queue[dict[str, Any] | None]] = set()
        try:
            await pubsub.subscribe(_events_channel(session_id))
            ready.set()
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                try:
                    event = json.loads(message["data"])
                except (TypeError, ValueError):
                    continue
                entry = self._pumps.get(session_id)
                subs = entry[1] if entry is not None else set()
                for queue in list(subs):
                    with contextlib.suppress(asyncio.QueueFull):
                        queue.put_nowait(event)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("event bus pump failed for session %s", session_id)
        finally:
            ready.set()  # never leave subscribe() waiters hanging
            with contextlib.suppress(Exception):
                await pubsub.unsubscribe(_events_channel(session_id))
                await pubsub.aclose()
            entry = self._pumps.get(session_id)
            subscribers = entry[1] if entry is not None else subs
            for queue in list(subscribers):
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(None)

    async def aclose(self) -> None:
        for session_id in list(self._pumps):
            entry = self._pumps.pop(session_id)
            entry[0].cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await entry[0]
            for queue in list(entry[1]):
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(None)


class _RedisStreamHandle:
    __slots__ = ("queue",)

    def __init__(self, queue: asyncio.Queue[dict[str, Any] | None]) -> None:
        self.queue = queue

    async def get(self) -> dict[str, Any] | None:
        return await self.queue.get()


class RedisSessionStore:
    """Redis-backed store for multi-node deployments (plan §7, path B)."""

    def __init__(self, redis: Any, grace_seconds: float, call_timeout: float) -> None:
        self._r = redis
        self.grace_seconds = grace_seconds
        self.call_timeout = call_timeout
        self._bus = _LocalBus(redis)
        # Node-local pending calls: the future lives on the node that accepted
        # the MCP client's tools/call; any node can resolve it via pub/sub.
        self._local_pending: dict[str, PendingCall] = {}
        self._local_futures: dict[str, asyncio.Future[dict[str, Any]]] = {}

    @property
    def _session_ttl(self) -> int:
        return max(1, int(self.grace_seconds))

    @property
    def _stream_ttl(self) -> int:
        # Refreshed by the stream holder on every keepalive (~25 s).
        return max(10, min(35, self._session_ttl))

    # -- sessions -----------------------------------------------------------

    async def create(self) -> Session:
        session = Session(id=new_session_id())
        async with self._r.pipeline(transaction=True) as pipe:
            pipe.hset(_session_key(session.id), mapping=_dump_session(session))
            pipe.expire(_session_key(session.id), self._session_ttl)
            await pipe.execute()
        return session

    async def get(self, session_id: str) -> Session | None:
        h = await self._r.hgetall(_session_key(session_id))
        if not h:
            return None
        return Session.from_dict(
            {
                "id": h["id"],
                "created_at": float(h["created_at"]),
                "last_seen": float(h["last_seen"]),
                "revision": int(h["revision"]),
                "tools": json.loads(h.get("tools") or "{}"),
                "context": json.loads(h.get("context") or "{}"),
                "pending_masks": json.loads(h.get("pending_masks") or "{}"),
            }
        )

    async def touch(self, session_id: str) -> None:
        key = _session_key(session_id)
        async with self._r.pipeline(transaction=True) as pipe:
            pipe.hset(key, "last_seen", repr(time.time()))
            pipe.expire(key, self._session_ttl)
            await pipe.execute()

    async def delete(self, session_id: str) -> None:
        await self._r.delete(_session_key(session_id), _stream_key(session_id))

    async def apply_message(self, session_id: str, msg: dict[str, Any]) -> ApplyOutcome | None:
        # Advisory lock so two nodes applying revisions for the same session
        # don't interleave their read-modify-write.
        got_lock = False
        for _ in range(50):
            if await self._r.set(_lock_key(session_id), "1", nx=True, px=3000):
                got_lock = True
                break
            await asyncio.sleep(0.03)
        if not got_lock:
            logger.warning("apply_message: lock timeout for %s; applying unlocked", session_id)
        try:
            session = await self.get(session_id)
            if session is None:
                return None
            outcome = apply_message(session, msg)
            if outcome.applied:
                async with self._r.pipeline(transaction=True) as pipe:
                    pipe.hset(_session_key(session_id), mapping=_dump_session(session))
                    pipe.expire(_session_key(session_id), self._session_ttl)
                    await pipe.execute()
            return outcome
        finally:
            if got_lock:
                with contextlib.suppress(Exception):
                    await self._r.delete(_lock_key(session_id))

    # -- streams ------------------------------------------------------------

    async def attach_stream(self, session_id: str) -> StreamHandle | None:
        if not await self._r.exists(_session_key(session_id)):
            return None
        await self.stream_heartbeat(session_id)
        queue = await self._bus.subscribe(session_id)
        return _RedisStreamHandle(queue)

    async def detach_stream(self, session_id: str, handle: StreamHandle) -> None:
        if isinstance(handle, _RedisStreamHandle):
            await self._bus.unsubscribe(session_id, handle.queue)
        with contextlib.suppress(Exception):
            await self._r.delete(_stream_key(session_id))

    async def stream_active(self, session_id: str) -> bool:
        return bool(await self._r.exists(_stream_key(session_id)))

    async def stream_heartbeat(self, session_id: str) -> None:
        await self._r.set(_stream_key(session_id), "1", ex=self._stream_ttl)
        await self.touch(session_id)

    async def publish_event(self, session_id: str, event: dict[str, Any]) -> None:
        await self._r.publish(_events_channel(session_id), json.dumps(event))

    # -- pending calls ------------------------------------------------------

    async def new_pending(self, session_id: str, name: str, args: dict[str, Any]) -> PendingCall | None:
        if not await self._r.exists(_session_key(session_id)):
            return None
        pending = PendingCall(call_id=new_call_id(), session_id=session_id, name=name, args=args)
        ttl = int(self.call_timeout) + 60
        await self._r.set(
            _call_key(pending.call_id),
            json.dumps({"session_id": session_id, "name": name}),
            ex=max(60, ttl),
        )
        self._local_pending[pending.call_id] = pending
        fut = asyncio.get_running_loop().create_future()
        # Awaited indirectly (the bus loop routes call_result events into
        # await_call); retrieve exceptions so teardown never logs
        # "Future exception was never retrieved".
        fut.add_done_callback(lambda f: None if f.cancelled() else f.exception())
        self._local_futures[pending.call_id] = fut
        return pending

    async def await_call(self, pending: PendingCall, timeout: float) -> dict[str, Any]:
        fut = self._local_futures.get(pending.call_id)
        if fut is None:
            raise SessionClosed("pending call unknown")
        # subscribe() waits for the pump's server-side SUBSCRIBE, so anything
        # published from here on reaches the queue. A result published BEFORE
        # this point (the FE is fast, we subscribe last) is caught by the
        # durable result key check below.
        queue = await self._bus.subscribe(pending.session_id)
        try:
            async with asyncio.timeout(timeout):
                raw = await self._r.getdel(_result_key(pending.call_id))
                if raw is not None:
                    return json.loads(raw)
                while True:
                    event = await queue.get()
                    if event is None:
                        raise SessionClosed("event bus closed")
                    etype = event.get("event")
                    if etype == EVENT_CALL_RESULT and event["data"].get("callId") == pending.call_id:
                        raw = await self._r.getdel(_result_key(pending.call_id))
                        return json.loads(raw) if raw is not None else {}
                    elif etype == EVENT_SESSION_CLOSED:
                        raise SessionClosed("session closed")
        finally:
            self._local_pending.pop(pending.call_id, None)
            self._local_futures.pop(pending.call_id, None)
            await self._bus.unsubscribe(pending.session_id, queue)

    async def drop_pending(self, session_id: str, call_id: str) -> None:
        self._local_pending.pop(call_id, None)
        fut = self._local_futures.pop(call_id, None)
        if fut is not None and not fut.done():
            fut.cancel()
        with contextlib.suppress(Exception):
            await self._r.delete(_call_key(call_id), _result_key(call_id))

    async def resolve_call(self, session_id: str, call_id: str, payload: dict[str, Any]) -> bool:
        record = await self._r.getdel(_call_key(call_id))
        if record is None:
            return False
        try:
            sid = json.loads(record)["session_id"]
        except (ValueError, KeyError):
            sid = session_id
        # Durable result first, then the wake-up event: the awaiter may still
        # be mid-SUBSCRIBE, and pub/sub would silently drop an early event.
        # The event carries no payload; the key (TTL'd) is the source.
        ttl = max(60, int(self.call_timeout) + 60)
        await self._r.set(_result_key(call_id), json.dumps(payload), ex=ttl)
        await self.publish_event(sid, {"event": EVENT_CALL_RESULT, "data": {"callId": call_id}})
        return True

    async def fail_all_pending(self, session_id: str, exc: Exception) -> None:
        for call_id, pending in list(self._local_pending.items()):
            if pending.session_id != session_id:
                continue
            self._local_pending.pop(call_id, None)
            fut = self._local_futures.pop(call_id, None)
            if fut is not None and not fut.done():
                fut.set_exception(exc)
            with contextlib.suppress(Exception):
                await self._r.delete(_call_key(call_id), _result_key(call_id))

    async def close(self) -> None:
        await self._bus.aclose()
        await self._r.aclose()
