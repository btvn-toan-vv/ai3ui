# Plan: FE ↔ mcp-adapter bridge with per-session MCP servers

Status: §9 interface reshape approved. No code written against this yet.

## 1. What we are building

The browser is the source of truth for tools and state: `useTool` / `useContext`
register them, handlers execute in the browser. `mcp-adapter` (FastMCP, Python)
turns each connected frontend into a real MCP server that any MCP client can
talk to.

Flow, end to end:

1. The FE opens a session with mcp-adapter. The server issues a **unique,
   unguessable session id**.
2. That id gives the session a public MCP endpoint:
   `http(s)://<domain>/{id}/mcp` (MCP Streamable HTTP).
3. The FE pushes its registry (tools, context slices, masking) to the adapter.
4. The adapter exposes the **non-masked** tools through `/{id}/mcp` and
   advertises the `tools.listChanged` capability.
5. When masking (or registration) changes, the FE POSTs the change; the
   adapter emits `notifications/tools/list_changed` to connected MCP clients.
6. When an MCP client calls a tool, the adapter forwards the call to the FE
   over the session's server→FE stream, waits for the FE to POST the result
   back, and answers the client.

## 2. Terminology — two different SSE channels

Both directions use SSE-shaped plumbing; keep them apart.

- **Session stream (ours)**: FE → `GET /sessions` upgrades to SSE. Server→FE
  only. Carries the handshake, heartbeats, and tool-call requests. This is a
  custom protocol, not MCP.
- **MCP endpoint (spec)**: `/{id}/mcp` speaks MCP *Streamable HTTP* (the
  current transport; the old MCP "HTTP+SSE" transport is deprecated). Clients
  of this endpoint are MCP clients — agents, IDEs, Claude, etc.

## 3. Architecture

```
┌─────────────┐  register     ┌──────────────┐
│  useTool /  │──────────────▶│ local        │
│  useContext │               │ registry     │
└─────────────┘               └──────┬───────┘
                                     │ snapshot/diffs (POST, revisioned)
                                     ▼
┌─────────────┐  tool calls   ┌──────────────┐   POST result    ┌────────────┐
│  MCP client │◀─────────────▶│ mcp-adapter  │◀────────────────▶│     FE     │
└─────────────┘  list_changed │  /{id}/mcp   │   tool_call via  │  handler   │
                              └──────────────┘   session SSE     └────────────┘
```

## 4. Session lifecycle & handshake

1. **Create**: `GET /sessions` (SSE). Adapter creates a session record and
   sends a `session` event as the first frame:

   ```json
   { "id": "sess_01J…", "mcpUrl": "https://<domain>/sess_01J…/mcp",
     "postUrl": "/sessions/sess_01J…/messages" }
   ```

   - `id`: `sess_` + UUIDv4 (128-bit). It is a bearer credential — see §8.
   - `mcpUrl` is sent, not derived by the FE, so the URL scheme stays
     server-owned (works behind any proxy/domain setup).

2. **Active**: adapter sends `:ping` SSE comments every ~25 s (provider- and
   proxy-proof keepalive). Any FE POST also refreshes `last_seen`.

3. **Reconnect**: FE reconnects with `GET /sessions/{id}/stream` +
   `Last-Event-ID`. A **grace period** (60 s) survives page reloads; MCP
   clients see no interruption.

4. **Expire/close**: no stream and no heartbeat past the grace period →
   teardown: session, registry, pending calls cancelled (MCP clients get an
   error), `/{id}/mcp` starts 404ing. FE may also close explicitly:
   `DELETE /sessions/{id}` (sent via `navigator.sendBeacon` on page unload).

## 5. Registry sync (FE → adapter)

All FE POSTs go to `postUrl` (`/sessions/{id}/messages`) as small JSON
messages, each carrying a client-side monotonically increasing **`revision`**.
The adapter keeps the highest revision seen and drops stale/arbitrarily
reordered messages — POSTs can race, SSE cannot.

- `registry.snapshot` — full state, sent right after handshake and as the
  resync fallback: `{ revision, tools: [...], context: [...] }`.
- `registry.tool_upsert` — `{ revision, tool }` (registration, schema or
  description change).
- `registry.tool_remove` — `{ revision, name }`.
- `registry.tool_mask` — `{ revision, name, available }`. Emitted by the FE's
  sync layer whenever a live-read `available` flips; the FE does **not** need
  a separate user action for masking, it diffs consecutive registry versions.
- `registry.context_upsert` / `registry.context_remove` — same, for slices.

Tool schemas cross the wire as **JSON Schema** (the FE serializes zod → JSON
Schema; zod ships a converter — defer the exact library choice to
implementation).

## 6. Per-session MCP server (`/{id}/mcp`)

- One MCP Streamable HTTP endpoint per session, backed by the session's
  registry snapshot. Implementation inside FastMCP: either a FastMCP instance
  per session with runtime tool registration, or one app routing by `{id}` to
  per-session tool registries — decide at implementation time; the routing
  variant is more likely to scale (fewer app instances, cheaper churn).
- Advertised capabilities:

  ```json
  { "tools": { "listChanged": true } }
  ```

- **Masking is enforced server-side, twice**: masked tools are absent from
  `tools/list` **and** `tools/call` on a masked or unknown name is refused
  (deny by default — a client caching a stale list can never execute a masked
  tool).
- `notifications/tools/list_changed` is emitted on: tool added, tool removed,
  `available` flip, schema/description change.
- Tool-call routing: `tools/call` → new `pending_calls[callId]` → `tool_call`
  event on the session SSE → FE executes the handler → FE POSTs
  `call_result { callId, result | error }` → adapter resolves the MCP
  response. Calls carry a server-side timeout (default 60 s, aligned with the
  FE's own tool-timeout story later); timeout/cancel (client disconnect or
  MCP `notifications/cancelled`) → the FE gets `tool_call_cancelled`.
- Context slices: v1 ships tools only. Optional v2: expose slices as MCP
  **resources** with `resources.listChanged` — flagged here, not committed.

## 7. Session management & horizontal scaling

Design the store behind an interface from day one:

```python
class SessionStore(Protocol):
    async def create(self) -> Session: ...
    async def get(self, id: str) -> Session | None: ...
    async def put_registry(self, id: str, rev: int, registry: Registry) -> None: ...
    async def touch(self, id: str) -> None: ...
    async def delete(self, id: str) -> None: ...
    async def pending_call(self, id: str, call: PendingCall) -> None: ...
    async def resolve_call(self, id: str, call_id: str, result: ...) -> None: ...
```

- **Now**: `InMemorySessionStore` (dicts + TTL reaper task). Single node.
- **Scale path A — sticky routing (cheap)**: every route embeds `{id}`
  (`/sessions/{id}/…`, `/{id}/mcp`), so an L7 load balancer can hash on the
  path segment. Keeps the in-memory store even when multi-node. Cost: a node
  dying kills its sessions; hotspotting possible.
- **Scale path B — shared state (real target)**: `RedisSessionStore`.
  - Session + registry in Redis hashes with TTL (refreshed by `touch`).
  - Cross-node events via Redis pub/sub, one channel per session
    (`sess:{id}:events`) — the node holding the SSE subscribes; any node
    accepting a POST publishes. This is what makes "FE's stream and FE's POSTs
    land on different nodes" safe.
  - Pending calls in Redis (`call_id → session_id`, with TTL); the FE's
    `call_result` can hit any node, which publishes the result back to the
    node holding the MCP client request.
- Either way: id-in-path routing works for both, sessions are cheap and
  disposable, and expiry is TTL-driven in both stores.
- Load note: traffic scales with **connected sessions**, not requests; the
  heavy state (registry snapshots) is small (KBs) — thousands of sessions per
  node before Redis is needed.

## 8. Security

- `id` is unguessable (128-bit) and is the only credential: treat
  `/{id}/mcp` like a bearer URL. Rotate on session rebuild; expire on TTL.
- Optional later: per-session auth token, CORS allowlist, rate limits on
  session creation.
- Masking enforcement lives on the adapter (§6), never trusting the FE's
  own filtering.

## 9. Interface reshape for `ai3ui` (confirmed)

This plan supersedes what `useRegistry` declared when it was first sketched.
There it *streamed the registry from* the server; here the FE is the source
of truth and *pushes to* it. The reshape is approved and is the design to
implement against:

- The session (id, SSE stream, sync engine) belongs in a provider-level
  connection built from `serverUrl` — hooks stay untouched: `useTool` /
  `useContext` register locally, the sync layer diffs versions and POSTs
  (mask flips included, no extra user API).
- `useRegistry` keeps reading the **local** live registry (its masking-debug
  role), gaining `{ sessionId, mcpUrl, status, error }` from the connection.
  The `eventsPath`/`reconnect` options move to the provider/connection layer.
- New dispatcher: incoming `tool_call` events resolve against the local
  registry and run browser handlers.

## 10. Milestones

1. mcp-adapter: session create/handshake/TTL + in-memory store (no MCP yet).
2. FE sync: snapshot POST after handshake, revisioned diffs, mask diffs.
3. `/{id}/mcp`: tools/list + tools/call + `listChanged`, with FE execution
   round-trip over the session stream.
4. Reconnect/grace, explicit close, cancels, timeouts.
5. Redis store + multi-node validation.
