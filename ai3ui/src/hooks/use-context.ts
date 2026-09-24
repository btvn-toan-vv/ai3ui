import type { DependencyList } from "react";
import type { ContextDefinition } from "../types";

/**
 * State registration. Publishes a context slice while the component is
 * mounted. `deps` is optional; like `useTool`, the value is read from the
 * latest render, so a missing dep cannot make the model read stale state.
 */
export declare function useContext(slice: ContextDefinition, deps?: DependencyList): void;

/** Same hook as `useContext`, under a name that never collides with React's own. */
export declare const useAI3UIContext: typeof useContext;
