import type { DependencyList } from "react";
import type { ToolDefinition } from "../types";

/**
 * Tool registration. Registers a tool for as long as the component is
 * mounted.
 *
 * `deps` is optional and only affects when the *registration* is torn down
 * and redone. It does not affect what the handler sees: the registry holds a
 * thin wrapper that reads `handler`, `available` and `description` from the
 * latest render, so a handler can close over state freely and still read
 * current values.
 */
export declare function useTool<S>(tool: ToolDefinition<S>, deps?: DependencyList): void;
