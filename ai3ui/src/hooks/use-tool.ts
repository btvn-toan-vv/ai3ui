import { useLayoutEffect, useRef } from "react";
import type { DependencyList } from "react";
import type { RegisteredTool } from "../registry";
import type { SchemaOutput, ToolDefinition } from "../types";
import { useBridgeContext } from "./provider";

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
export function useTool<S>(tool: ToolDefinition<S>, deps: DependencyList = []): void {
  const { registry } = useBridgeContext();
  const latest = useRef(tool);
  latest.current = tool;

  useLayoutEffect(() => {
    const registered: RegisteredTool = {
      name: latest.current.name,
      get description() {
        return latest.current.description;
      },
      get params() {
        return latest.current.params;
      },
      get available() {
        return latest.current.available ?? true;
      },
      handler: (args, ctx) =>
        latest.current.handler(args as SchemaOutput<S>, ctx),
    };
    registry.registerTool(registered);
    return () => registry.unregisterTool(registered.name, registered);
    // The wrapper reads everything live from `latest`; only identity-affecting
    // inputs belong in the dep list, plus whatever the caller passes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, tool.name, ...deps]);

  /**
   * Live-field change detection. The wrapper's getters mean a mask flip
   * (`available` changing on state) mutates NOTHING in the registry, so
   * there is no version bump and no sync — the hook must say it happened.
   * Compare-then-touch only: an unconditional touch notifies subscribers on
   * every render and loops render→notify→render.
   */
  const lastSynced = useRef<{ available: boolean; description: string } | null>(null);
  useLayoutEffect(() => {
    const current = {
      available: tool.available ?? true,
      description: tool.description,
    };
    const prev = lastSynced.current;
    if (
      prev !== null &&
      (prev.available !== current.available ||
        prev.description !== current.description)
    ) {
      registry.touch();
    }
    lastSynced.current = current;
  });
}
