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

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


class SseReader:
    """Incremental SSE parser over a streaming httpx response."""

    def __init__(self, response: httpx.Response) -> None:
        self._response = response
        self._lines = response.aiter_lines()

    async def next_event(self, timeout: float = 15.0) -> dict[str, str] | None:
        """Parse one event block. Returns {"event": ..., "data": ...} or None
        at stream end. Comments (":ping") and blanks are skipped."""

        async def _read() -> dict[str, str] | None:
            event = "message"
            data: list[str] = []
            async for line in self._lines:
                if not line.strip():
                    if data:
                        return {"event": event, "data": "\n".join(data)}
                    continue
                if line.startswith(":"):
                    continue
                if line.startswith("event:"):
                    event = line[len("event:") :].strip()
                elif line.startswith("data:"):
                    data.append(line[len("data:") :].strip())
            return None

        return await asyncio.wait_for(_read(), timeout=timeout)


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
        stream_ctx = client.stream("GET", "/sessions")
        sse_resp = await stream_ctx.__aenter__()
        check("1. GET /sessions returns SSE",
              sse_resp.status_code == 200
              and sse_resp.headers.get("content-type", "").startswith("text/event-stream"),
              f"status={sse_resp.status_code}")
        reader = SseReader(sse_resp)
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

        # Background pump for server->FE events after the handshake frame.
        session_events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        async def pump() -> None:
            try:
                while True:
                    ev = await reader.next_event(timeout=60)
                    if ev is None:
                        break
                    await session_events.put(ev)
            except Exception:  # noqa: BLE001 - stream end/cancel
                pass

        pump_task = asyncio.create_task(pump())

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
                "context": [],
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

            # -- 4. tools/list: only the non-masked tool ----------------------
            tools = await mcp.rpc("tools/list")
            names = [t["name"] for t in tools.get("result", {}).get("tools", [])]
            check("4. tools/list shows only the exposed tool", names == ["alpha"], str(names))

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
                  r.status_code == 200 and names == ["alpha", "beta"], str(names))

            # -- 6. Tool-call round-trip over the session stream --------------
            async def call_and_wait(name: str, args: dict[str, Any]) -> dict[str, Any]:
                return (await mcp.rpc("tools/call", {"name": name, "arguments": args},
                                      timeout=30)).get("result", {})

            # 6a. ok:true path
            call_task = asyncio.create_task(call_and_wait("alpha", {"x": 41}))
            ev = await asyncio.wait_for(session_events.get(), timeout=10)
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

            # 6b. ok:false path
            call_task = asyncio.create_task(call_and_wait("beta", {}))
            ev = await asyncio.wait_for(session_events.get(), timeout=10)
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
            check("7. stale revision not applied", names == ["alpha", "beta"], str(names))
        finally:
            pump_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pump_task
            await stream_ctx.__aexit__(None, None, None)

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
