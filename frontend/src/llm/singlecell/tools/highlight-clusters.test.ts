// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { AI2UIProvider, useEngineContext } from "@bioturing-org/ai2ui";
import type { ViewStore } from "../../../state/useViewStore";
import type { ClusterInfo } from "../../../lib/types";
import { useHighlightClustersTool } from "./highlight-clusters";

function fakeView(overrides: Partial<ViewStore> = {}): ViewStore {
  return {
    colorMode: "cluster",
    genes: [],
    ramp: "expression",
    highlighted: null,
    lastDeg: null,
    error: null,
    showGenes: vi.fn(),
    colorByCluster: vi.fn(),
    setHighlight: vi.fn(),
    setLastDeg: vi.fn(),
    setRamp: vi.fn(),
    setError: vi.fn(),
    ...overrides,
  };
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(AI2UIProvider, { gateway: { origin: "" }, user: null, children });

/**
 * Mounts `useHighlightClustersTool` under a real provider and hands back
 * the engine it registered against, so a test can reach the tool through
 * `engine.registry.getTool(name)` — the same path the app uses — instead
 * of a standalone builder that no longer exists.
 */
function mountTool(view: ViewStore, clusters: ClusterInfo[]) {
  const { result } = renderHook(
    () => {
      useHighlightClustersTool(view, clusters);
      return useEngineContext();
    },
    { wrapper },
  );
  return result.current.engine;
}

const ctx = { signal: new AbortController().signal, ask: {} as never };

describe("highlight_clusters", () => {
  it("registers under the name highlight_clusters, feature singlecell", () => {
    const engine = mountTool(fakeView(), []);
    const t = engine.registry.getTool("highlight_clusters");
    expect(t?.name).toBe("highlight_clusters");
    expect(t?.group).toBe("singlecell");
  });

  it("clears highlighting on an empty array", async () => {
    const setHighlight = vi.fn();
    const view = fakeView({ setHighlight });
    const engine = mountTool(view, [{ id: 0, label: "B cells", nCells: 10 }]);
    const t = engine.registry.getTool("highlight_clusters")!;
    const result = await t.handler({ clusters: [] }, ctx);
    expect(setHighlight).toHaveBeenCalledWith(null);
    expect(result).toMatchObject({ ok: true });
  });

  it("resolves a substring match and reports unmatched labels", async () => {
    const setHighlight = vi.fn();
    const view = fakeView({ setHighlight });
    const clusters = [
      { id: 0, label: "CD14+ Monocytes", nCells: 10 },
      { id: 1, label: "FCGR3A+ Monocytes", nCells: 5 },
    ];
    const engine = mountTool(view, clusters);
    const t = engine.registry.getTool("highlight_clusters")!;
    const result = await t.handler({ clusters: ["monocytes", "nonexistent"] }, ctx);
    expect(setHighlight).toHaveBeenCalledWith(["CD14+ Monocytes", "FCGR3A+ Monocytes"]);
    expect(result).toMatchObject({ ok: true });
    if (result && typeof result === "object" && "message" in result) {
      expect(String(result.message)).toContain("nonexistent");
    }
  });
});
