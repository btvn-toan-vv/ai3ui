// @vitest-environment happy-dom
/**
 * Mounts every single-cell tool hook the way `useSingleCell()` does (see
 * `./index.ts`), minus the two store hooks (`useViewStore`/
 * `useDatasetStore`) it also calls. Those need `ViewProvider`/
 * `DatasetProvider`, and `DatasetProvider` fires a real `fetchDataset()` on
 * mount — irrelevant to what this file checks (tool names and `feature`
 * tags) and not worth dragging a network mock in for. Driving the six
 * `use*Tool` hooks directly, under the real `AI2UIProvider`, still proves
 * the thing this file cares about: each tool a fake view can supply
 * registers under the right name and is tagged `feature: singlecell`.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { AI2UIProvider, useEngineContext } from "@bioturing-org/ai2ui";
import type { ViewStore } from "../../state/useViewStore";
import { useRunDegTool } from "./tools/run-deg";
import { useQueryGenesTool } from "./tools/query-genes";
import { useColorByClusterTool } from "./tools/color-by-cluster";
import { useSearchGenesTool } from "./tools/search-genes";
import { useHighlightClustersTool } from "./tools/highlight-clusters";
import { useSetColorRampTool } from "./tools/set-color-ramp";

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

function mountAllTools(view: ViewStore) {
  const { result } = renderHook(
    () => {
      useRunDegTool(view);
      useQueryGenesTool(view);
      useColorByClusterTool(view);
      useSearchGenesTool();
      useHighlightClustersTool(view, []);
      useSetColorRampTool(view);
      return useEngineContext();
    },
    { wrapper },
  );
  return result.current.engine;
}

const EXPECTED_NAMES = ["color_by_cluster", "highlight_clusters", "query_genes", "run_deg", "search_genes", "set_color_ramp"];
// The provider always registers these three now — no opt-in prop to
// suppress them (see `@bioturing-org/ai2ui`'s provider.tsx, BUILTIN_TOOLS).
const BUILTIN_NAMES = ["ask_user", "create_document", "wait"];

describe("ask_user_choice", () => {
  it("is not ported — the ask_user built-in covers it", () => {
    const engine = mountAllTools(fakeView());
    const names = engine.registry.toolSchemas().map((t) => t.name);
    expect(names).not.toContain("ask_user_choice");
    expect(names.sort()).toEqual([...EXPECTED_NAMES, ...BUILTIN_NAMES].sort());
  });

  it("every single-cell tool is tagged feature: singlecell", () => {
    const engine = mountAllTools(fakeView());
    for (const name of EXPECTED_NAMES) {
      expect(engine.registry.getTool(name)?.group).toBe("singlecell");
    }
  });
});
