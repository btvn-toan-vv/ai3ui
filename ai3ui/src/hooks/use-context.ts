import { useLayoutEffect, useRef } from "react";
import type { DependencyList } from "react";
import type { ContextDefinition } from "../types";
import { useBridgeContext } from "./provider";

/**
 * State registration. Publishes a context slice while the component is
 * mounted. `deps` is optional; like `useTool`, the value is read from the
 * latest render, so a missing dep cannot make the model read stale state.
 */
export function useContext(slice: ContextDefinition, deps: DependencyList = []): void {
  const { registry } = useBridgeContext();
  const latest = useRef(slice);
  latest.current = slice;

  useLayoutEffect(() => {
    const registered: ContextDefinition = {
      key: latest.current.key,
      get description() {
        return latest.current.description;
      },
      get value() {
        return latest.current.value;
      },
      get volatile() {
        return latest.current.volatile;
      },
    };
    registry.registerContext(registered);
    return () => registry.unregisterContext(registered.key, registered);
    // Getters read the latest render; only `key` identity plus caller deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, slice.key, ...deps]);
}

/** Same hook as `useContext`, under a name that never collides with React's own. */
export const useAI3UIContext = useContext;
