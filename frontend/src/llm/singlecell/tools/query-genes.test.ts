// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { AI2UIProvider, useEngineContext } from "@bioturing-org/ai2ui";
import type { ViewStore } from "../../../state/useViewStore";
import type { GeneVector } from "../../../lib/types";

const displayGenesMock = vi.fn();

vi.mock("../../../lib/geneDisplay", () => ({
  displayGenes: (...args: unknown[]) => displayGenesMock(...args),
}));

// Imported after the mock above so `query-genes.tsx` picks up the mocked module.
const { useQueryGenesTool } = await import("./query-genes");

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
 * Mounts `useQueryGenesTool` under a real provider and hands back the
 * engine it registered against, so a test can reach the tool through
 * `engine.registry.getTool(name)` — the same path the app uses — instead
 * of a standalone builder that no longer exists.
 */
function mountTool(view: ViewStore) {
  const { result } = renderHook(
    () => {
      useQueryGenesTool(view);
      return useEngineContext();
    },
    { wrapper },
  );
  return result.current.engine;
}

const ctx = { signal: new AbortController().signal, ask: {} as never };

beforeEach(() => {
  displayGenesMock.mockReset();
});

describe("query_genes", () => {
  it("registers under the name query_genes, feature singlecell", () => {
    const engine = mountTool(fakeView());
    const t = engine.registry.getTool("query_genes");
    expect(t?.name).toBe("query_genes");
    expect(t?.group).toBe("singlecell");
  });

  it("keeps the params schema UNCAPPED — no max() on the genes array", () => {
    const engine = mountTool(fakeView());
    const t = engine.registry.getTool("query_genes")!;
    // A schema with `.max(4)` would reject a 10-item array at safeParse time.
    // The cap must live in the handler, not the schema (see the tool's own
    // doc comment on the historical silent-truncation bug this guards).
    const many = Array.from({ length: 10 }, (_, i) => `G${i}`);
    const parsed = t.params.safeParse({ genes: many });
    expect(parsed.success).toBe(true);
  });

  it("enforces the cap in the handler and returns ok:false explaining it, without ever calling displayGenes", async () => {
    const view = fakeView();
    const engine = mountTool(view);
    const t = engine.registry.getTool("query_genes")!;
    const many = Array.from({ length: 10 }, (_, i) => `G${i}`);
    const result = await t.handler({ genes: many }, ctx);
    expect(result).toMatchObject({ ok: false });
    if (result && typeof result === "object" && "message" in result) {
      expect(String(result.message)).toMatch(/4/); // MAX_GENES
      expect(String(result.message)).toContain("10");
    }
    if (result && typeof result === "object" && "hint" in result) {
      expect(typeof result.hint).toBe("string");
    }
    // The whole point: an over-cap request never silently truncates and
    // succeeds — it never even reaches the fetch-then-store path.
    expect(displayGenesMock).not.toHaveBeenCalled();
  });

  it("shows genes within the cap by delegating to displayGenes", async () => {
    const shown: GeneVector[] = [{ gene: "CD3D", values: [1, 2], min: 0, max: 2, pctExpressing: 0.5 }];
    displayGenesMock.mockImplementation(async (_symbols, _existing, target) => {
      target.showGenes(shown);
    });
    const showGenes = vi.fn();
    const view = fakeView({ showGenes });
    const engine = mountTool(view);
    const t = engine.registry.getTool("query_genes")!;
    const result = await t.handler({ genes: ["CD3D"] }, ctx);
    expect(showGenes).toHaveBeenCalledWith(shown);
    expect(result).toMatchObject({ ok: true });
  });
});
