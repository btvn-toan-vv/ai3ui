"""Session state, wire models, and the pure registry-application logic.

This module is store-agnostic: both the in-memory and the Redis store keep a
:class:`Session` per FE connection and mutate it through :func:`apply_message`,
so the revision/masking semantics are identical on a single node and across a
Redis-backed fleet.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

# ---------------------------------------------------------------------------
# Wire models (see the FE<->adapter contract)
# ---------------------------------------------------------------------------

REGISTRY_MESSAGE_TYPES = frozenset(
    {
        "registry.snapshot",
        "registry.tool_upsert",
        "registry.tool_remove",
        "registry.tool_mask",
        "registry.context_upsert",
        "registry.context_remove",
    }
)


def new_session_id() -> str:
    """Session id: ``sess_`` + uuid4 hex (128-bit bearer credential)."""
    return "sess_" + uuid.uuid4().hex


@dataclass
class ToolRec:
    """Server-side copy of a ToolWire object."""

    name: str
    description: str = ""
    schema: dict[str, Any] = field(default_factory=lambda: {"type": "object", "properties": {}})
    available: bool = True

    def to_wire(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "schema": self.schema,
            "available": self.available,
        }

    @classmethod
    def from_wire(cls, wire: dict[str, Any]) -> ToolRec:
        schema = wire.get("schema")
        if not isinstance(schema, dict):
            schema = {"type": "object", "properties": {}}
        return cls(
            name=str(wire.get("name") or ""),
            description=str(wire.get("description") or ""),
            schema=schema,
            available=bool(wire.get("available", True)),
        )


@dataclass
class SliceRec:
    """Server-side copy of a SliceWire object (context slices; v1: stored only,
    not yet exposed as MCP resources)."""

    key: str
    description: str = ""
    value: str = ""
    volatile: bool = False

    def to_wire(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "description": self.description,
            "value": self.value,
            "volatile": self.volatile,
        }

    @classmethod
    def from_wire(cls, wire: dict[str, Any]) -> SliceRec:
        return cls(
            key=str(wire.get("key") or ""),
            description=str(wire.get("description") or ""),
            value=str(wire.get("value") or ""),
            volatile=bool(wire.get("volatile", False)),
        )


@dataclass
class Session:
    id: str
    created_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    revision: int = 0
    tools: dict[str, ToolRec] = field(default_factory=dict)
    context: dict[str, SliceRec] = field(default_factory=dict)
    # Mask overrides received for tools not (yet) registered. Applied when the
    # tool arrives via tool_upsert/snapshot-with-... no: applied on upsert.
    pending_masks: dict[str, bool] = field(default_factory=dict)

    def touch(self) -> None:
        self.last_seen = time.time()

    # -- (de)serialization for the Redis store -----------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "created_at": self.created_at,
            "last_seen": self.last_seen,
            "revision": self.revision,
            "tools": {n: t.to_wire() for n, t in self.tools.items()},
            "context": {k: s.to_wire() for k, s in self.context.items()},
            "pending_masks": dict(self.pending_masks),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Session:
        s = cls(id=data["id"])
        s.created_at = float(data.get("created_at", time.time()))
        s.last_seen = float(data.get("last_seen", time.time()))
        s.revision = int(data.get("revision", 0))
        s.tools = {n: ToolRec.from_wire(w) for n, w in (data.get("tools") or {}).items()}
        s.context = {k: SliceRec.from_wire(w) for k, w in (data.get("context") or {}).items()}
        s.pending_masks = {str(k): bool(v) for k, v in (data.get("pending_masks") or {}).items()}
        return s


# ---------------------------------------------------------------------------
# Pending tool calls
# ---------------------------------------------------------------------------


class SessionClosed(Exception):
    """Raised while awaiting a call result when the session is torn down."""


@dataclass
class PendingCall:
    call_id: str
    session_id: str
    name: str
    args: dict[str, Any]
    created_at: float = field(default_factory=time.time)


def new_call_id() -> str:
    return uuid.uuid4().hex


# ---------------------------------------------------------------------------
# Registry application (shared by both stores)
# ---------------------------------------------------------------------------


def exposed_tools(session: Session) -> dict[str, ToolRec]:
    """The MCP-exposed tool set: tools with ``available is not False``."""
    return {n: t for n, t in session.tools.items() if t.available is not False}


def _exposed_fingerprint(session: Session) -> dict[str, str]:
    """Stable signature of the exposed set; any change here must trigger
    ``notifications/tools/list_changed``."""

    def sig(t: ToolRec) -> str:
        return json.dumps(
            {"description": t.description, "schema": t.schema},
            sort_keys=True,
            default=str,
        )

    return {name: sig(tool) for name, tool in exposed_tools(session).items()}


def _context_fingerprint(session: Session) -> dict[str, str]:
    """Key -> description of every slice: the text the built-in
    ``get_ui_context`` description is rendered from (values excluded — a
    value-only flip changes no listing)."""
    return {key: s.description for key, s in session.context.items()}


#: Name of the adapter-defined tool that reads UI context slices back. FE
#: tools cannot shadow it — registrations under this name are dropped.
GET_UI_CONTEXT_TOOL = "get_ui_context"

logger_registry = logging.getLogger("mcp_adapter.sessions")


@dataclass
class ApplyOutcome:
    applied: bool  # False => stale revision, silently dropped
    exposed_changed: bool  # True => exposed tool set changed -> notify clients
    context_changed: bool = False  # True => slice keys/descriptions changed (built-in reader text)


def apply_message(session: Session, msg: dict[str, Any]) -> ApplyOutcome:
    """Apply one FE registry message to ``session`` in place.

    Stale messages (``revision <= session.revision``) are silently dropped so
    racing POSTs can never roll the registry back. Caller must validate the
    message shape first (see :func:`validate_message`).
    """
    before = _exposed_fingerprint(session)
    before_context = _context_fingerprint(session)

    rev = int(msg["revision"])
    if rev <= session.revision:
        return ApplyOutcome(applied=False, exposed_changed=False)
    session.revision = rev
    session.touch()

    mtype = msg["type"]
    if mtype == "registry.snapshot":
        tools = [ToolRec.from_wire(w) for w in msg["tools"]]
        tools = [t for t in tools if _not_reserved(t.name)]
        session.tools = {t.name: t for t in tools}
        session.context = {s.key: s for s in (SliceRec.from_wire(w) for w in msg["context"])}
        session.pending_masks.clear()  # snapshot is the full truth
    elif mtype == "registry.tool_upsert":
        tool = ToolRec.from_wire(msg["tool"])
        if not _not_reserved(tool.name):
            pass
        else:
            if tool.name in session.pending_masks:
                # A mask arrived before the tool existed: keep enforcing it.
                tool.available = session.pending_masks.pop(tool.name)
            session.tools[tool.name] = tool
    elif mtype == "registry.tool_remove":
        session.tools.pop(msg["name"], None)
    elif mtype == "registry.tool_mask":
        available = bool(msg["available"])
        if not _not_reserved(msg["name"]):
            pass  # the built-in is always exposed; FE masks don't apply
        else:
            tool = session.tools.get(msg["name"])
            if tool is not None:
                tool.available = available
            else:
                # Tool not registered (yet): remember the mask.
                session.pending_masks[msg["name"]] = available
    elif mtype == "registry.context_upsert":
        sl = SliceRec.from_wire(msg["slice"])
        session.context[sl.key] = sl
    elif mtype == "registry.context_remove":
        session.context.pop(msg["key"], None)
    else:  # pragma: no cover - validate_message guards this
        raise ValueError(f"unknown registry message type: {mtype}")

    after = _exposed_fingerprint(session)
    return ApplyOutcome(
        applied=True,
        exposed_changed=before != after,
        context_changed=before_context != _context_fingerprint(session),
    )


def _not_reserved(name: str) -> bool:
    if name == GET_UI_CONTEXT_TOOL:
        logger_registry.warning(
            "FE tried to register/mask reserved tool %r — ignored (adapter-defined)",
            GET_UI_CONTEXT_TOOL,
        )
        return False
    return True


def validate_message(msg: Any) -> str | None:
    """Return an error string when a POSTed message is malformed, else None."""
    if not isinstance(msg, dict):
        return "message must be a JSON object"
    mtype = msg.get("type")
    if not isinstance(mtype, str):
        return "missing 'type'"
    if mtype in REGISTRY_MESSAGE_TYPES:
        rev = msg.get("revision")
        if not isinstance(rev, int) or isinstance(rev, bool):
            return "registry message missing integer 'revision'"
        match mtype:
            case "registry.snapshot":
                if not isinstance(msg.get("tools"), list) or not isinstance(
                    msg.get("context"), list
                ):
                    return "snapshot requires 'tools' and 'context' lists"
            case "registry.tool_upsert":
                w = msg.get("tool")
                if not isinstance(w, dict) or not isinstance(w.get("name"), str) or not w["name"]:
                    return "tool_upsert requires tool.name"
            case "registry.tool_remove":
                if not isinstance(msg.get("name"), str) or not msg["name"]:
                    return "tool_remove requires 'name'"
            case "registry.tool_mask":
                if not isinstance(msg.get("name"), str) or not msg["name"]:
                    return "tool_mask requires 'name'"
                if not isinstance(msg.get("available"), bool):
                    return "tool_mask requires boolean 'available'"
            case "registry.context_upsert":
                w = msg.get("slice")
                if not isinstance(w, dict) or not isinstance(w.get("key"), str) or not w["key"]:
                    return "context_upsert requires slice.key"
            case "registry.context_remove":
                if not isinstance(msg.get("key"), str) or not msg["key"]:
                    return "context_remove requires 'key'"
    elif mtype == "call_result":
        if not isinstance(msg.get("callId"), str) or not msg["callId"]:
            return "call_result requires 'callId'"
        if not isinstance(msg.get("ok"), bool):
            return "call_result requires boolean 'ok'"
        if msg["ok"] and not isinstance(msg.get("message"), str):
            return "call_result ok:true requires string 'message'"
        if (
            not msg["ok"]
            and msg.get("message") is not None
            and not isinstance(msg.get("message"), str)
        ):
            return "call_result ok:false 'message' must be a string"
    elif mtype == "session.close":
        pass
    else:
        return f"unknown message type: {mtype}"
    return None
