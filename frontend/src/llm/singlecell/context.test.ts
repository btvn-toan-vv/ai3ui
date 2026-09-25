// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { AI2UIProvider, useEngineContext, type ContextDefinition } from "@bioturing-org/ai2ui";
import { useSingleCellGroundTruthContext, useDomainContext, domainContext } from "./context";
import { MAX_GENES } from "../../lib/constants";
import type { ViewStore } from "../../state/useViewStore";
import type { DatasetResponse } from "../../lib/types";

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
 * Mounts `useSingleCellGroundTruthContext` under a real provider and reads
 * the "singlecell-ground-truth" slice back off the engine's registry — the
 * same path the model's own prompt-builder uses — instead of a standalone
 * builder that no longer exists.
 */
function mountGroundTruth(view: ViewStore, data: DatasetResponse | null): ContextDefinition {
  const { result } = renderHook(
    () => {
      useSingleCellGroundTruthContext(view, data);
      return useEngineContext();
    },
    { wrapper },
  );
  const slice = result.current.engine.registry.contextSlices().find((c) => c.key === "singlecell-ground-truth");
  if (!slice) throw new Error("singlecell-ground-truth slice did not register");
  return slice;
}

describe("singlecell-ground-truth context", () => {
  it("is volatile and carries maxGenesAtOnce so the model sees the cap before violating it", () => {
    const slice = mountGroundTruth(fakeView(), null);
    expect(slice.key).toBe("singlecell-ground-truth");
    expect(slice.volatile).toBe(true);
    const value = JSON.parse(slice.value) as { maxGenesAtOnce: number; displayedGeneCount: number };
    expect(value.maxGenesAtOnce).toBe(MAX_GENES);
    expect(value.displayedGeneCount).toBe(0);
  });

  it("drops the STATE BEATS HISTORY / recomputed-every-message paragraphs from its description — the gateway's FROZEN preamble carries them now", () => {
    const slice = mountGroundTruth(fakeView(), null);
    expect(slice.description.toLowerCase()).not.toContain("state beats history");
    expect(slice.description.toLowerCase()).not.toContain("recomputed and resent");
  });

  it("reflects live genes/highlight/ramp state, not a frozen snapshot", () => {
    const view = fakeView({
      colorMode: "expression",
      genes: [{ gene: "CD3D", values: [1], min: 0, max: 1, pctExpressing: 1 }],
      highlighted: ["B cells"],
      ramp: "viridis",
    });
    const slice = mountGroundTruth(view, null);
    const value = JSON.parse(slice.value) as { displayedGenes: unknown[]; highlightedClusters: string[]; colorRamp: string };
    expect(value.displayedGenes).toHaveLength(1);
    expect(value.highlightedClusters).toEqual(["B cells"]);
    expect(value.colorRamp).toMatch(/viridis/);
  });
});

describe("domain context", () => {
  it("is static (volatile: false) and keyed 'domain'", () => {
    expect(domainContext.key).toBe("domain");
    expect(domainContext.volatile).toBe(false);
  });

  it("keeps the domain-specific rules the generic gateway preamble cannot know", () => {
    const v = domainContext.value;
    expect(v).toMatch(/CD4/);
    expect(v).toMatch(/CD8/);
    expect(v).toMatch(/HGNC/);
    expect(v).toMatch(/run_deg/);
    expect(v).toMatch(/query_genes/);
    expect(v).toMatch(/log2FC/);
    expect(v).toMatch(/FDR/);
    // References the builtin, not the deleted ask_user_choice tool.
    expect(v).toMatch(/ask_user/);
    expect(v).not.toMatch(/select_option/);
    expect(v).not.toMatch(/ask_user_choice/);
  });

  it("useDomainContext registers the same constant under the engine's registry", () => {
    const { result } = renderHook(
      () => {
        useDomainContext();
        return useEngineContext();
      },
      { wrapper },
    );
    const slice = result.current.engine.registry.contextSlices().find((c) => c.key === "domain");
    expect(slice).toEqual(domainContext);
  });
});
