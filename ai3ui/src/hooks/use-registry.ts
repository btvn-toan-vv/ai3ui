import type { ContextDefinition, ToolDefinition } from "../types";

/** Lifecycle of the SSE connection to the registry server. */
export type RegistryConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

export type UseRegistryOptions = {
  /**
   * SSE endpoint path on the server. Defaults to `"/sse"`, the conventional
   * FastMCP (mcp-adapter) path.
   */
  eventsPath?: string;
  /**
   * Reconnect with backoff when the stream drops. Defaults to `true`.
   */
  reconnect?: boolean;
};

export type UseRegistry = {
  tools: ToolDefinition[];
  context: ContextDefinition[];
  /** State of the SSE connection to `serverUrl`. */
  status: RegistryConnectionStatus;
  /** Set when `status` is `"error"`; cleared on the next reconnect attempt. */
  error: Error | undefined;
};

/**
 * Streams the registry from the backend: opens an SSE connection to
 * `serverUrl` and keeps `tools` and `context` in sync with what the server
 * pushes — including tools currently masked with `available: false`.
 *
 * The connection lives for as long as the component is mounted. Changing
 * `serverUrl` or `options.eventsPath` tears it down and reconnects.
 *
 * The backend side lives in `mcp-adapter` and is not implemented yet.
 */
export declare function useRegistry(
  serverUrl: string,
  options?: UseRegistryOptions,
): UseRegistry;
