import type { CallResult, Registry, RegistrySnapshot } from "./registry";
import type { SliceWire, ToolWire } from "./types";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

/** Immutable connection snapshot for `useSyncExternalStore`-style reads. */
export type ConnectionState = {
  status: ConnectionStatus;
  error: Error | undefined;
  sessionId: string | undefined;
  mcpUrl: string | undefined;
  postUrl: string | undefined;
  /** Human-facing docs page for the live session; absent on older adapters. */
  docsUrl: string | undefined;
};

/** Every JSON message the frontend can POST to `postUrl`. */
export type OutboundMessage =
  | {
      type: "registry.snapshot";
      revision: number;
      tools: ToolWire[];
      context: SliceWire[];
    }
  | { type: "registry.tool_upsert"; revision: number; tool: ToolWire }
  | { type: "registry.tool_remove"; revision: number; name: string }
  | {
      type: "registry.tool_mask";
      revision: number;
      name: string;
      available: boolean;
    }
  | { type: "registry.context_upsert"; revision: number; slice: SliceWire }
  | { type: "registry.context_remove"; revision: number; key: string }
  | {
      type: "call_result";
      callId: string;
      ok: boolean;
      message: string;
      data?: unknown;
      hint?: string;
    }
  | { type: "session.close" };

type RegistryMessage = Extract<
  OutboundMessage,
  { revision: number }
>;

type ConnectionListener = () => void;

const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 5000;

/** Thrown when the server 404s a reconnect: the session is gone for good. */
class SessionGoneError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" no longer exists on the server`);
    this.name = "SessionGoneError";
  }
}

type SseFrame = { event: string; data: string };

/**
 * Minimal SSE frame splitter over a fetch response body. Handles `\n` / `\r\n`
 * framing, multi-line `data:` fields, and ignores `:ping` keepalive comments.
 * `id:`/`retry:` fields carry no meaning for this protocol and are dropped.
 */
async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (match === null) break;
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line === "" || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let fieldValue = colon === -1 ? "" : line.slice(colon + 1);
          if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
          if (field === "event") event = fieldValue;
          else if (field === "data") dataLines.push(fieldValue);
        }
        if (dataLines.length > 0) {
          yield { event, data: dataLines.join("\n") };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function backoffMs(failures: number): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_CAP_MS);
  // 50–150% jitter so reconnecting tabs don't thunder in lockstep.
  return Math.round(base * (0.5 + Math.random()));
}

/**
 * Owns the FE ↔ mcp-adapter session: handshake, reconnect, registry sync
 * (snapshot + revisioned diffs), inbound tool execution and orderly close.
 * Framework-free; the React provider wraps this.
 */
export class BridgeConnection {
  private readonly registry: Registry;
  private serverUrl: string;

  private state: ConnectionState = {
    status: "idle",
    error: undefined,
    sessionId: undefined,
    mcpUrl: undefined,
    postUrl: undefined,
    docsUrl: undefined,
  };
  private readonly listeners = new Set<ConnectionListener>();

  /** Client-side revision counter; resets only on a NEW session id. */
  private revision = 0;
  /** Ordered delivery chain for revisioned registry messages. */
  private queue: Promise<void> = Promise.resolve();
  /** Last state acknowledged to the server, for diffing. */
  private lastSynced: RegistrySnapshot | undefined;

  private closed = true;
  private wentLive = false;
  private streamAbort: AbortController | undefined;
  private readonly pendingCalls = new Map<string, AbortController>();
  private unloadListenersAttached = false;

  constructor(registry: Registry, serverUrl: string) {
    this.registry = registry;
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.registry.subscribe(this.onRegistryChange);
  }

  // Arrow properties: stable identities for `useSyncExternalStore`.
  readonly subscribe = (listener: ConnectionListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ConnectionState => this.state;

  /** Points the connection at a different server. Only meaningful pre-connect. */
  setServerUrl(serverUrl: string): void {
    const next = normalizeServerUrl(serverUrl);
    if (next === this.serverUrl) return;
    this.teardown("idle");
    this.serverUrl = next;
  }

  /** Starts (or resumes) the session. Idempotent while connecting/open. */
  connect(): void {
    if (!this.closed) return;
    this.closed = false;
    this.attachUnloadListeners();
    void this.runLoop();
  }

  /** Explicitly ends the session and stops everything. Idempotent. */
  close(): void {
    this.teardown("closed");
  }

  private async runLoop(): Promise<void> {
    let failures = 0;
    while (!this.closed) {
      this.setState({ status: "connecting" });
      try {
        await this.openStream();
      } catch (err) {
        if (this.closed) return;
        if (err instanceof SessionGoneError) {
          // 404 on the reconnect URL: forget the session and fall through to
          // a fresh handshake immediately — no backoff, it's deterministic.
          this.clearSession();
          failures = 0;
          continue;
        }
        // A POST failure already flipped us to "error" with the meaningful
        // cause; the stream error caught here (usually the abort we caused
        // ourselves) must not overwrite it.
        if (this.state.status !== "error") {
          this.setState({ error: toError(err) });
        }
      }
      if (this.closed) return;
      if (this.wentLive) {
        // The stream worked and then dropped: fast path back.
        this.wentLive = false;
        failures = 0;
      } else {
        failures += 1;
      }
      await sleep(backoffMs(failures));
    }
  }

  private async openStream(): Promise<void> {
    const sessionId = this.state.sessionId;
    const reconnect = sessionId !== undefined;
    const url = reconnect
      ? `${this.serverUrl}/sessions/${sessionId}/stream`
      : `${this.serverUrl}/sessions`;
    const abort = new AbortController();
    this.streamAbort = abort;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return; // close()/teardown: stop quietly.
      throw err;
    }
    if (reconnect && response.status === 404) {
      throw new SessionGoneError(sessionId);
    }
    if (!response.ok) {
      throw new Error(
        `Bridge stream request failed: ${response.status} ${response.statusText} (${url})`,
      );
    }
    if (response.body === null) {
      throw new Error("Bridge stream response had no body");
    }
    this.wentLive = true;
    if (reconnect) {
      // The reconnect stream does not repeat the `session` frame; adopt the
      // session we already hold and get the server back in sync.
      this.onStreamReady();
    }
    for await (const frame of readSseFrames(response.body)) {
      this.handleFrame(frame);
    }
    // Clean server-side end of stream → runLoop reconnects.
  }

  private handleFrame(frame: SseFrame): void {
    if (frame.event === "session") {
      let data: { id?: unknown; mcpUrl?: unknown; postUrl?: unknown; docsUrl?: unknown };
      try {
        data = JSON.parse(frame.data) as typeof data;
      } catch {
        return; // malformed handshake frame: ignore
      }
      if (
        typeof data.id !== "string" ||
        typeof data.mcpUrl !== "string" ||
        typeof data.postUrl !== "string"
      ) {
        return;
      }
      this.adoptSession({
        id: data.id,
        mcpUrl: data.mcpUrl,
        postUrl: data.postUrl,
        docsUrl: typeof data.docsUrl === "string" ? data.docsUrl : undefined,
      });
      return;
    }
    if (frame.event === "tool_call") {
      let call: { callId?: unknown; name?: unknown; args?: unknown };
      try {
        call = JSON.parse(frame.data) as typeof call;
      } catch {
        return;
      }
      if (typeof call.callId !== "string" || typeof call.name !== "string") {
        return;
      }
      this.handleToolCall(call.callId, call.name, call.args);
      return;
    }
    if (frame.event === "tool_call_cancelled") {
      let cancel: { callId?: unknown };
      try {
        cancel = JSON.parse(frame.data) as typeof cancel;
      } catch {
        return;
      }
      if (typeof cancel.callId !== "string") return;
      this.pendingCalls.get(cancel.callId)?.abort();
    }
    // Anything else (including "message") is not part of the protocol: ignore.
  }

  private adoptSession(session: {
    id: string;
    mcpUrl: string;
    postUrl: string;
    docsUrl: string | undefined;
  }): void {
    if (session.id !== this.state.sessionId) {
      // A NEW session id: the revision counter resets. Abandon any calls the
      // old session had in flight — the server has forgotten them.
      this.revision = 0;
      this.abortPendingCalls();
      this.queue = Promise.resolve();
    }
    this.setState({
      sessionId: session.id,
      mcpUrl: session.mcpUrl,
      postUrl: session.postUrl,
      docsUrl: session.docsUrl,
    });
    this.onStreamReady();
  }

  /**
   * Stream is live and the session id is known: mark open and push a full
   * snapshot so the server is never behind, on handshake AND on reconnect.
   */
  private onStreamReady(): void {
    this.setState({ status: "open", error: undefined });
    this.pushSnapshot();
  }

  private pushSnapshot(): void {
    const snapshot = this.registry.snapshot();
    this.lastSynced = snapshot;
    this.enqueue({ type: "registry.snapshot", ...snapshot });
  }

  // ── Registry sync ────────────────────────────────────────────────────────

  private readonly onRegistryChange = (): void => {
    if (this.state.status !== "open" || this.lastSynced === undefined) {
      // Not connected: the snapshot sent on (re)connect covers everything.
      return;
    }
    const current = this.registry.snapshot();
    const messages = diffSnapshots(this.lastSynced, current);
    if (messages.length === 0) return;
    this.lastSynced = current;
    for (const message of messages) {
      this.enqueue(message);
    }
  };

  private enqueue(message: RegistryDiffMessage): void {
    // Spreading the union plus `revision` rebuilds the matching wire variant;
    // TS cannot prove that, hence the cast.
    const revisioned = {
      ...message,
      revision: ++this.revision,
    } as RegistryMessage;
    this.queue = this.queue.then(() => this.postRegistryMessage(revisioned));
  }

  private async postRegistryMessage(message: RegistryMessage): Promise<void> {
    if (this.closed || this.state.status !== "open") return;
    try {
      await this.post(message);
    } catch (err) {
      // Poison the queue: anything still queued is superseded by the full
      // resnapshot that fires when the stream recovers.
      this.queue = Promise.resolve();
      this.setState({ status: "error", error: toError(err) });
      // Kill the stream; runLoop's catch reconnects with backoff and the
      // reconnect path re-pushes a full snapshot. Must not rethrow here —
      // `this.queue` has no consumer, a rejection would go unhandled.
      this.streamAbort?.abort();
    }
  }

  // ── Inbound tool calls ───────────────────────────────────────────────────

  private handleToolCall(callId: string, name: string, args: unknown): void {
    const controller = new AbortController();
    this.pendingCalls.get(callId)?.abort();
    this.pendingCalls.set(callId, controller);
    void this.registry
      .execute(name, args, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return; // cancelled: stay silent
        this.postCallResult(callId, result);
      })
      .finally(() => {
        if (this.pendingCalls.get(callId) === controller) {
          this.pendingCalls.delete(callId);
        }
      });
  }

  private postCallResult(callId: string, result: CallResult): void {
    const message: OutboundMessage = { type: "call_result", callId, ...result };
    // Not revisioned and not queued: results are independent datapoints.
    void this.post(message).catch(() => {
      // Nothing useful to do — the server-side call will time out there.
    });
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private async post(message: OutboundMessage, keepalive = false): Promise<void> {
    const postUrl = this.state.postUrl;
    if (postUrl === undefined) return;
    const response = await fetch(`${this.serverUrl}${postUrl}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      keepalive,
    });
    if (!response.ok) {
      throw new Error(
        `Bridge POST failed: ${response.status} ${response.statusText} for ${message.type}`,
      );
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private teardown(status: "closed" | "idle"): void {
    if (this.closed && this.state.status === status) return;
    this.closed = true;
    this.detachUnloadListeners();
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    this.abortPendingCalls();
    this.queue = Promise.resolve();
    this.lastSynced = undefined;

    const { sessionId, postUrl } = this.state;
    if (sessionId !== undefined && postUrl !== undefined) {
      // Best-effort explicit close: session.close + DELETE, both keepalive so
      // they still get out when called from an unload path off the beacon.
      void this.post({ type: "session.close" }, true).catch(() => {});
      void fetch(`${this.serverUrl}/sessions/${sessionId}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
    }
    this.clearSession();
    this.revision = 0;
    this.setState({ status, error: undefined });
  }

  private clearSession(): void {
    this.setState({
      sessionId: undefined,
      mcpUrl: undefined,
      postUrl: undefined,
      docsUrl: undefined,
    });
  }

  private abortPendingCalls(): void {
    for (const controller of this.pendingCalls.values()) {
      controller.abort();
    }
    this.pendingCalls.clear();
  }

  private readonly onPageHide = (): void => {
    const { sessionId, postUrl } = this.state;
    if (sessionId === undefined || postUrl === undefined) return;
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
    const body = JSON.stringify({ type: "session.close" });
    navigator.sendBeacon(
      `${this.serverUrl}${postUrl}`,
      new Blob([body], { type: "application/json" }),
    );
  };

  private attachUnloadListeners(): void {
    if (this.unloadListenersAttached || typeof window === "undefined") return;
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("beforeunload", this.onPageHide);
    this.unloadListenersAttached = true;
  }

  private detachUnloadListeners(): void {
    if (!this.unloadListenersAttached || typeof window === "undefined") return;
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("beforeunload", this.onPageHide);
    this.unloadListenersAttached = false;
  }

  // ── State plumbing ───────────────────────────────────────────────────────

  private setState(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "");
}

// ── Diffing ──────────────────────────────────────────────────────────────

/** A registry message before its revision number is assigned at enqueue. */
type RegistryDiffMessage =
  | { type: "registry.snapshot"; tools: ToolWire[]; context: SliceWire[] }
  | { type: "registry.tool_upsert"; tool: ToolWire }
  | { type: "registry.tool_remove"; name: string }
  | { type: "registry.tool_mask"; name: string; available: boolean }
  | { type: "registry.context_upsert"; slice: SliceWire }
  | { type: "registry.context_remove"; key: string };

function diffSnapshots(
  prev: RegistrySnapshot,
  next: RegistrySnapshot,
): RegistryDiffMessage[] {
  const messages: RegistryDiffMessage[] = [];
  diffTools(prev, next, messages);
  diffContext(prev, next, messages);
  return messages;
}

function diffTools(
  prev: RegistrySnapshot,
  next: RegistrySnapshot,
  out: RegistryDiffMessage[],
): void {
  const prevByName = new Map(prev.tools.map((tool) => [tool.name, tool]));
  const nextByName = new Map(next.tools.map((tool) => [tool.name, tool]));
  for (const name of prevByName.keys()) {
    if (!nextByName.has(name)) {
      out.push({ type: "registry.tool_remove", name });
    }
  }
  for (const tool of next.tools) {
    const before = prevByName.get(tool.name);
    if (before === undefined) {
      out.push({ type: "registry.tool_upsert", tool });
      continue;
    }
    if (jsonEqual(before, tool)) continue;
    if (
      before.description === tool.description &&
      jsonEqual(before.schema, tool.schema) &&
      before.available !== tool.available
    ) {
      // Pure mask flip.
      out.push({
        type: "registry.tool_mask",
        name: tool.name,
        available: tool.available,
      });
      continue;
    }
    out.push({ type: "registry.tool_upsert", tool });
  }
}

function diffContext(
  prev: RegistrySnapshot,
  next: RegistrySnapshot,
  out: RegistryDiffMessage[],
): void {
  const prevByKey = new Map(prev.context.map((slice) => [slice.key, slice]));
  const nextByKey = new Map(next.context.map((slice) => [slice.key, slice]));
  for (const key of prevByKey.keys()) {
    if (!nextByKey.has(key)) {
      out.push({ type: "registry.context_remove", key });
    }
  }
  for (const slice of next.context) {
    const before = prevByKey.get(slice.key);
    if (before === undefined || !jsonEqual(before, slice)) {
      out.push({ type: "registry.context_upsert", slice });
    }
  }
}
