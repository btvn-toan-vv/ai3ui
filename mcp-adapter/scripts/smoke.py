#!/usr/bin/env python3
"""End-to-end smoke test for mcp-adapter — no browser involved.

Prereq: the server is running:

    cd mcp-adapter
    uv run uvicorn --factory mcp_adapter.server:create_app --host 127.0.0.1 --port 8123

Then, in another shell:

    uv run scripts/smoke.py            # or: uv run scripts/smoke.py 8123

Exercises the full contract: SSE handshake, registry sync with revisions,
MCP initialize/tools/list/tools/call (Streamable HTTP), masking, the
tool_call <-> call_result round-trip, stale-revision drops, and teardown 404s.
Exit code 0 iff every step passes.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import sys
from typing import Any

import httpx

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
BASE = f"http://127.0.0.1:{PORT}"

import os
TRACE_STREAM = bool(os.environ.get("TRACE_STREAM"))

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


class SessionStream:
    """Long-lived GET /sessions over a raw socket.

    httpx has proven flaky for this one role in this environment (host
    CPython 3.14): under extra concurrent MCP traffic the pooled idle
    connection carrying the SSE stream gets torn down client-side and the
    adapter's uvicorn then sees a disconnect mid-event-wait. The smoke owns
    this socket outright — HTTP/1.1 chunked in, SSE frames out — and nothing
    else shares it.
    """

    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self.status = 0
        self.headers: dict[str, str] = {}
        self.events: asyncio.Queue[dict[str, str] | None] = asyncio.Queue()
        self._pump: asyncio.Task[None] | None = None
        self._writer: asyncio.StreamWriter | None = None

    async def open(self) -> None:
        reader, writer = await asyncio.open_connection(self.host, self.port)
        self._writer = writer
        writer.write(
            f"GET /sessions HTTP/1.1\r\nHost: {self.host}:{self.port}\r\n"
            "Accept: text/event-stream\r\n\r\n".encode()
        )
        await writer.drain()
        head = b""
        while b"\r\n\r\n" not in head:
            data = await reader.read(4096)
            if not data:
                raise ConnectionError("server closed before headers")
            head += data
        head_lines, rest = head.split(b"\r\n\r\n", 1)
        lines = head_lines.decode().split("\r\n")
        self.status = int(lines[0].split(" ", 2)[1])
        self.headers = {
            k.lower(): v.strip()
            for k, v in (line.split(":", 1) for line in lines[1:] if ":" in line)
        }
        self._pump = asyncio.create_task(self._read_chunks(reader, rest))

    async def _read_chunks(self, reader: asyncio.StreamReader, buf: bytes) -> None:
        frames = ""
        try:
            while True:
                while b"\r\n" not in buf:  # chunk header line
                    data = await reader.read(4096)
                    if not data:
                        return
                    buf += data
                size_line, buf = buf.split(b"\r\n", 1)
                size = int(size_line.split(b";", 1)[0].strip() or b"0", 16)
                if size == 0:
                    return
                while len(buf) < size + 2:
                    data = await reader.read(4096)
                    if not data:
                        return
                    buf += data
                if TRACE_STREAM:
                    print(f"CHUNK size={size} bytes={buf[:size]!r}")
                frames += buf[:size].decode(errors="replace")
                buf = buf[size + 2 :]  # consume chunk + trailing CRLF
                frames, events = self._drain_frames(frames)
                if TRACE_STREAM and events:
                    print(f"DRAIN -> {len(events)} event(s): {[e['event'] for e in events]}")
                for event in events:
                    await self.events.put(event)
        except Exception:
            if TRACE_STREAM:
                import traceback
                traceback.print_exc()
            raise
        finally:
            await self.events.put(None)

    @staticmethod
    def _drain_frames(frames: str) -> tuple[str, list[dict[str, str]]]:
        """Split complete \\n\\n-terminated SSE frames off the front of the
        buffer. Ping-only frames (no data:) yield nothing."""
        out: list[dict[str, str]] = []
        while True:
            idx = frames.find("\n\n")
            if idx == -1:
                return frames, out
            raw, frames = frames[:idx], frames[idx + 2 :]
            event, data_lines = "message", []
            for ln in raw.replace("\r\n", "\n").split("\n"):
                if not ln or ln.startswith(":"):
                    continue
                if ln.startswith("event:"):
                    event = ln[6:].strip()
                elif ln.startswith("data:"):
                    data_lines.append(ln[5:].lstrip(" "))
            if data_lines:
                out.append({"event": event, "data": "\n".join(data_lines)})

    async def next_event(self, timeout: float = 15.0) -> dict[str, str] | None:
        return await asyncio.wait_for(self.events.get(), timeout)

    async def close(self) -> None:
        if self._writer is not None:
            with contextlib.suppress(Exception):
                self._writer.close()
                await self._writer.wait_closed()
        if self._pump is not None:
            self._pump.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._pump



def parse_sse_text(body: str, want_id: Any = None) -> dict[str, Any] | None:
    """Find the JSON-RPC message with `want_id` inside an SSE response body."""
    data_lines: list[str] = []
    found = None
    for line in body.splitlines() + [""]:
        if not line.strip():
            if data_lines:
                payload = json.loads("\n".join(data_lines))
                if want_id is None or payload.get("id") == want_id:
                    found = payload
                    if want_id is not None:
                        return found
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            data_lines.append(line[len("data:") :].strip())
    return found


class McpHttpClient:
    """Minimal MCP Streamable-HTTP client (SSE response flavor)."""

    def __init__(self, client: httpx.AsyncClient, url: str) -> None:
        self._client = client
        self.url = url
        self.session_id: str | None = None
        self._next_id = 0

    def _headers(self) -> dict[str, str]:
        h = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        if self.session_id:
            h["mcp-session-id"] = self.session_id
        return h

    async def post_message(self, message: dict[str, Any]) -> httpx.Response:
        resp = await self._client.post(self.url, json=message, headers=self._headers())
        if self.session_id is None and resp.headers.get("mcp-session-id"):
            self.session_id = resp.headers["mcp-session-id"]
        return resp

    async def rpc(self, method: str, params: dict[str, Any] | None = None,
                  timeout: float = 30.0) -> dict[str, Any]:
        self._next_id += 1
        req_id = self._next_id
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            message["params"] = params
        resp = await self._client.post(
            self.url, json=message, headers=self._headers(), timeout=timeout
        )
        if self.session_id is None and resp.headers.get("mcp-session-id"):
            self.session_id = resp.headers["mcp-session-id"]
        ctype = resp.headers.get("content-type", "")
        if "application/json" in ctype:
            return resp.json()
        body = resp.text
        result = parse_sse_text(body, want_id=req_id)
        if result is None:
            raise RuntimeError(f"no JSON-RPC response for id={req_id} in: {body!r}")
        return result

    async def notify(self, method: str) -> int:
        resp = await self.post_message({"jsonrpc": "2.0", "method": method})
        return resp.status_code


async def main() -> int:
    async with httpx.AsyncClient(base_url=BASE, timeout=httpx.Timeout(30.0, connect=5.0)) as client:
        # -- 1. Handshake ----------------------------------------------------
        stream = SessionStream("127.0.0.1", PORT)
        await stream.open()
        check("1. GET /sessions returns SSE",
              stream.status == 200
              and stream.headers.get("content-type", "").startswith("text/event-stream"),
              f"status={stream.status}")
        reader = stream
        try:
            frame = await reader.next_event()
        except Exception as exc:  # noqa: BLE001
            check("1. session event received", False, str(exc))
            return 1
        payload = json.loads(frame["data"]) if frame and frame["event"] == "session" else {}
        session_id = payload.get("id", "")
        mcp_url = payload.get("mcpUrl", "")
        post_url = payload.get("postUrl", "")
        mcp_url = mcp_url if mcp_url.startswith("http") else BASE + mcp_url
        ok = (
            bool(session_id.startswith("sess_"))
            and mcp_url == f"{BASE}/{session_id}/mcp"
            and post_url == f"/sessions/{session_id}/messages"
        )
        check("1. session frame has id/mcpUrl/postUrl", ok, f"id={session_id} mcpUrl={mcp_url}")

        # FE events are read straight off the stream — no forwarding pump;
        # one died silently once and starved the flow.

        mcp = McpHttpClient(client, mcp_url)

        try:
            # -- 2. Registry snapshot ---------------------------------------
            snapshot = {
                "type": "registry.snapshot",
                "revision": 1,
                "tools": [
                    {
                        "name": "alpha",
                        "description": "First tool",
                        "schema": {"type": "object",
                                   "properties": {"x": {"type": "number"}}},
                        "available": True,
                    },
                    {
                        "name": "beta",
                        "description": "Masked tool",
                        "schema": {"type": "object", "properties": {}},
                        "available": False,
                    },
                ],
                "context": [
                    {
                        "key": "board",
                        "description": "Board state summary.",
                        "value": "clean",
                        "volatile": True,
                    }
                ],
            }
            r = await client.post(post_url, json=snapshot)
            check("2. snapshot accepted", r.status_code == 200 and r.json().get("ok") is True)

            # -- 3. MCP initialize ------------------------------------------
            init = await mcp.rpc("initialize", {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "smoke", "version": "0.1.0"},
            })
            caps = init.get("result", {}).get("capabilities", {})
            check("3. initialize: tools.listChanged === true",
                  caps.get("tools", {}).get("listChanged") is True,
                  json.dumps(caps))
            status = await mcp.notify("notifications/initialized")
            check("3. notifications/initialized accepted", status in (200, 202), f"status={status}")

            # -- 4. tools/list: only the built-in reader + non-masked tool ----
            tools = await mcp.rpc("tools/list")
            names = [t["name"] for t in tools.get("result", {}).get("tools", [])]
            check("4. tools/list shows built-in + only the exposed tool",
                  names == ["get_ui_context", "alpha"], str(names))

            # -- 4b. get_ui_context (adapter-defined built-in) ---------------
            reader = next(t for t in tools["result"]["tools"] if t["name"] == "get_ui_context")
            check("4b. reader description lists feasible keys",
                  "- board" in reader.get("description", ""), reader.get("description", "")[:120])
            got = await mcp.rpc("tools/call", {"name": "get_ui_context", "arguments": {"key": "board"}})
            check("4b. get_ui_context(board) -> value",
                  got.get("result", {}).get("content", [{}])[0].get("text") == "clean"
                  and got.get("result", {}).get("isError") is False,
                  json.dumps(got.get("result", {}))[:140])
            unknown = await mcp.rpc("tools/call", {"name": "get_ui_context", "arguments": {"key": "nope"}})
            check("4b. unknown key -> isError with feasible keys",
                  unknown.get("result", {}).get("isError") is True
                  and "board" in unknown["result"]["content"][0]["text"],
                  json.dumps(unknown.get("result", {}))[:140])

            # Masked tool refused even though a client could know its name.
            refused = await mcp.rpc("tools/call", {"name": "beta", "arguments": {}})
            res = refused.get("result", {})
            check("4. tools/call on masked tool refused (isError)",
                  res.get("isError") is True, json.dumps(res)[:120])

            # -- 5. Unmask -> tools/list shows both ---------------------------
            r = await client.post(post_url, json={
                "type": "registry.tool_mask", "revision": 2, "name": "beta", "available": True,
            })
            tools = await mcp.rpc("tools/list")
            names = sorted(t["name"] for t in tools.get("result", {}).get("tools", []))
            check("5. unmasked tool appears in tools/list",
                  r.status_code == 200 and names == ["alpha", "beta", "get_ui_context"], str(names))

            # -- 6. Tool-call round-trip over the session stream --------------
            async def call_and_wait(name: str, args: dict[str, Any]) -> dict[str, Any]:
                return (await mcp.rpc("tools/call", {"name": name, "arguments": args},
                                      timeout=30)).get("result", {})

            # 6a. ok:true path
            call_task = asyncio.create_task(call_and_wait("alpha", {"x": 41}))
            ev = await asyncio.wait_for(stream.next_event(timeout=30), timeout=15)
            data = json.loads(ev["data"]) if ev["event"] == "tool_call" else {}
            check("6. tool_call event on session stream",
                  ev["event"] == "tool_call"
                  and data.get("name") == "alpha"
                  and data.get("args") == {"x": 41},
                  f"{ev['event']} {ev['data']}")
            r = await client.post(post_url, json={
                "type": "call_result", "callId": data["callId"],
                "ok": True, "message": "hello from FE", "data": {"echo": True},
            })
            check("6. call_result accepted", r.status_code == 200)
            result = await asyncio.wait_for(call_task, timeout=10)
            content = result.get("content", [])
            check("6. tools/call ok:true carries message",
                  result.get("isError") in (False, None)
                  and content and content[0].get("text") == "hello from FE",
                  json.dumps(result)[:160])
            check("6. structuredContent carries data",
                  result.get("structuredContent") == {"echo": True},
                  json.dumps(result.get("structuredContent")))

            # 6b. ok:false path — through a SECOND MCP session (any client
            # may call any exposed tool of the FE session).
            mcp2 = McpHttpClient(client, mcp_url)
            await mcp2.rpc("initialize", {
                "protocolVersion": "2025-03-26", "capabilities": {},
                "clientInfo": {"name": "smoke-2", "version": "0.1.0"},
            })
            await mcp2.notify("notifications/initialized")

            async def call2(name: str, args: dict[str, Any]) -> dict[str, Any]:
                return (await mcp2.rpc("tools/call", {"name": name, "arguments": args},
                                       timeout=30)).get("result", {})

            call_task = asyncio.create_task(call2("beta", {}))
            try:
                ev = await asyncio.wait_for(stream.next_event(timeout=30), timeout=15)
            except TimeoutError:
                print("DIAG: stream.events.qsize()=%d" % stream.events.qsize())
                raise
            data = json.loads(ev["data"]) if ev["event"] == "tool_call" else {}
            await client.post(post_url, json={
                "type": "call_result", "callId": data["callId"],
                "ok": False, "message": "boom", "hint": "check wiring",
            })
            result = await asyncio.wait_for(call_task, timeout=10)
            content = result.get("content", [])
            check("6. tools/call ok:false -> isError with message + hint",
                  result.get("isError") is True
                  and content and content[0].get("text") == "boom check wiring",
                  json.dumps(result)[:160])

            # -- 7. Stale revision dropped ------------------------------------
            r = await client.post(post_url, json={
                "type": "registry.snapshot", "revision": 1,
                "tools": [], "context": [],
            })
            check("7. stale revision POST still ok",
                  r.status_code == 200 and r.json().get("ok") is True)
            tools = await mcp.rpc("tools/list")
            names = sorted(t["name"] for t in tools.get("result", {}).get("tools", []))
            check("7. stale revision not applied", names == ["alpha", "beta", "get_ui_context"], str(names))
        finally:
            await stream.close()

        # -- 8. DELETE and 404s ----------------------------------------------
        r = await client.delete(f"/sessions/{session_id}")
        check("8. DELETE session", r.status_code == 200 and r.json().get("ok") is True)
        r = await client.post(post_url, json={"type": "session.close"})
        check("8. POST messages after close -> 404", r.status_code == 404, f"status={r.status_code}")
        r = await client.post(mcp_url, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                       "clientInfo": {"name": "smoke", "version": "0.1.0"}},
        }, headers={"Accept": "application/json, text/event-stream"})
        check("8. /{id}/mcp after close -> 404", r.status_code == 404, f"status={r.status_code}")
        r = await client.get(f"/sessions/{session_id}/stream")
        check("8. stream reattach after close -> 404", r.status_code == 404, f"status={r.status_code}")

    failed = [c for c in CHECKS if not c[1]]
    print()
    print(f"{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    return 0 if not failed else 1


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
