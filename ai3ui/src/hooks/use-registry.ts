import { useSyncExternalStore } from "react";
import type { ConnectionStatus } from "../connection";
import type { ContextDefinition, ToolDefinition } from "../types";
import { useBridgeContext } from "./provider";

export type UseRegistry = {
  /** Locally registered tools, including ones masked with `available: false`. */
  tools: ToolDefinition[];
  /** Locally registered context slices. */
  context: ContextDefinition[];
  /** Session id once the handshake completes. Bearer credential — treat as secret. */
  sessionId: string | undefined;
  /** Public MCP endpoint for this session, issued by the server. */
  mcpUrl: string | undefined;
  /** Human-facing docs page for the live session, issued by the server. */
  docsUrl: string | undefined;
  /** State of the connection to the mcp-adapter server. */
  status: ConnectionStatus;
  /** Last connection/sync error; cleared once the connection is open again. */
  error: Error | undefined;
};

/**
 * Reads the local live registry (tools/context as registered by `useTool` /
 * `useContext`, including masked tools) plus session state from the
 * connection owned by the enclosing `AI3UIProvider`.
 */
export function useRegistry(): UseRegistry {
  const { registry, connectionState } = useBridgeContext();
  const lists = useSyncExternalStore(registry.subscribe, registry.getLists);
  return {
    tools: lists.tools,
    context: lists.context,
    sessionId: connectionState.sessionId,
    mcpUrl: connectionState.mcpUrl,
    docsUrl: connectionState.docsUrl,
    status: connectionState.status,
    error: connectionState.error,
  };
}
