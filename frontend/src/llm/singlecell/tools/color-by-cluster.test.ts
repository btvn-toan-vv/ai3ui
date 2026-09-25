// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { AI2UIProvider, useEngineContext } from "@bioturing-org/ai2ui";
import type { ViewStore } from "../../../state/useViewStore";
import { useColorByClusterTool } from "./color-by-cluster";

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

// No gateway call is ever made — the hook only needs a real engine to
// register against, never a run — so a bare `{ url: "/x" }` is enough.
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(AI2UIProvider, { gateway: { origin: "" }, user: null, children });

/**
 * Mounts `useColorByClusterTool` under a real provider and hands back the
 * engine it registered against, so a test can reach the tool the same way
 * the app does — through `engine.registry.getTool(name)` — instead of
 * calling a standalone builder that no longer exists.
 */
function mountTool(view: ViewStore) {
  const { result } = renderHook(
    () => {
      useColorByClusterTool(view);
      return useEngineContext();
    },
    { wrapper },
  );
  return result.current.engine;
}

const ctx = { signal: new AbortController().signal, ask: {} as never };

describe("color_by_cluster", () => {
  it("registers under the name color_by_cluster, feature singlecell", () => {
    const engine = mountTool(fakeView());
    const t = engine.registry.getTool("color_by_cluster");
    expect(t?.name).toBe("color_by_cluster");
    expect(t?.group).toBe("singlecell");
  });

  it("resets the scatter to cluster colours", async () => {
    const colorByCluster = vi.fn();
    const view = fakeView({ colorByCluster });
    const engine = mountTool(view);
    const t = engine.registry.getTool("color_by_cluster")!;
    const result = await t.handler({}, ctx);
    expect(colorByCluster).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true });
  });
});
