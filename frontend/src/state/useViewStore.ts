/**
 * Holds the scatter plot's view state: color mode, the genes currently on
 * screen, the active ramp, cluster highlighting, the last DEG run, and any
 * error to surface. Plain `useState` + context — no state-management
 * library.
 *
 * `showGenes` is the SINGLE code path that puts genes on screen. It will be
 * called by three different callers later: the manual gene-input box
 * (Task 12), a clicked row in the DEG table (Task 12), and the `query_genes`
 * LLM tool (Task 14). Do not add a second "set genes" path — if the manual
 * flow and the agent flow ever diverge in how they display genes, one of
 * them is lying to the user about what's on screen.
 *
 * File is `.ts`, not `.tsx`: the Provider element is built with
 * `createElement` rather than JSX so this stays parseable without the JSX
 * loader.
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { DegResponse, GeneVector } from "../lib/types";

export interface ViewState {
  colorMode: "cluster" | "expression";
  /** 0-4 entries; >1 renders as small multiples. */
  genes: GeneVector[];
  ramp: "expression" | "viridis";
  /** Cluster labels dimmed to ~15% opacity when set; all clusters at full opacity when null. */
  highlighted: string[] | null;
  lastDeg: DegResponse | null;
  error: string | null;
}

const initialState: ViewState = {
  colorMode: "cluster",
  genes: [],
  ramp: "expression",
  highlighted: null,
  lastDeg: null,
  error: null,
};

export interface ViewStore extends ViewState {
  /** The ONE path that displays genes: sets `genes`, switches to "expression", clears `error`. */
  showGenes(g: GeneVector[]): void;
  /** Resets to categorical coloring AND clears the gene list. */
  colorByCluster(): void;
  setHighlight(c: string[] | null): void;
  setLastDeg(d: DegResponse | null): void;
  setRamp(r: "expression" | "viridis"): void;
  setError(e: string | null): void;
}

const ViewContext = createContext<ViewStore | null>(null);

export function ViewProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ViewState>(initialState);

  const showGenes = useCallback((g: GeneVector[]) => {
    setState((prev) => ({ ...prev, genes: g, colorMode: "expression", error: null }));
  }, []);

  const colorByCluster = useCallback(() => {
    setState((prev) => ({ ...prev, colorMode: "cluster", genes: [] }));
  }, []);

  const setHighlight = useCallback((c: string[] | null) => {
    setState((prev) => ({ ...prev, highlighted: c }));
  }, []);

  const setLastDeg = useCallback((d: DegResponse | null) => {
    setState((prev) => ({ ...prev, lastDeg: d }));
  }, []);

  const setRamp = useCallback((r: "expression" | "viridis") => {
    setState((prev) => ({ ...prev, ramp: r }));
  }, []);

  const setError = useCallback((e: string | null) => {
    setState((prev) => ({ ...prev, error: e }));
  }, []);

  const value = useMemo<ViewStore>(
    () => ({
      ...state,
      showGenes,
      colorByCluster,
      setHighlight,
      setLastDeg,
      setRamp,
      setError,
    }),
    [state, showGenes, colorByCluster, setHighlight, setLastDeg, setRamp, setError]
  );

  return createElement(ViewContext.Provider, { value }, children);
}

export function useViewStore(): ViewStore {
  const ctx = useContext(ViewContext);
  if (!ctx) {
    throw new Error("useViewStore must be used within a ViewProvider");
  }
  return ctx;
}
