import type { ContextDefinition, ToolDefinition } from "../types";

export type UseRegistry = {
  tools: ToolDefinition[];
  context: ContextDefinition[];
};

/**
 * Everything registered right now: every active `useTool` and `useContext`
 * call anywhere in the tree — including tools currently masked with
 * `available: false`. Reactive: mounting or unmounting a tool or context
 * slice re-renders anything that calls this hook. Use it to see exactly what
 * the model is told this turn.
 */
export declare function useRegistry(): UseRegistry;
