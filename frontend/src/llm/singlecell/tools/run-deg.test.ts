// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { AI2UIProvider, useEngineContext } from "@bioturing-org/ai2ui";
import type { ViewStore } from "../../../state/useViewStore";
import type { DegResponse } from "../../../lib/types";

const runDegMock = vi.fn();

vi.mock("../../../lib/api", () => ({
  runDeg: (...args: unknown[]) => runDegMock(...args),
}));

// Imported after the mock above so `run-deg.tsx` picks up the mocked module.
const { useRunDegTool } = await import("./run-deg");

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

function marker(gene: string, extra: Partial<DegResponse["markers"][number]> = {}) {
  return { gene, score: 1, log2fc: 1, pval: 0.01, fdr: 0.01, pctIn: 0.5, pctOut: 0.1, ...extra };
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(AI2UIProvider, { gateway: { origin: "" }, user: null, children });

/**
 * Mounts `useRunDegTool` under a real provider and hands back the engine
 * it registered against, so a test can reach the tool through
 * `engine.registry.getTool(name)` — the same path the app uses — instead
 * of a standalone builder that no longer exists.
 */
function mountTool(view: ViewStore) {
  const { result } = renderHook(
    () => {
      useRunDegTool(view);
      return useEngineContext();
    },
    { wrapper },
  );
  return result.current.engine;
}

const ctx = { signal: new AbortController().signal, ask: {} as never };

beforeEach(() => {
  runDegMock.mockReset();
});

describe("run_deg", () => {
  it("always computes the FULL marker list regardless of topN, but bounds the transcript slice", async () => {
    const allMarkers = Array.from({ length: 100 }, (_, i) => marker(`G${i}`));
    const degResponse: DegResponse = {
      group: "B cells", reference: "rest", nCellsGroup: 10, nCellsReference: 100, markers: allMarkers, warning: null,
    };
    runDegMock.mockResolvedValue(degResponse);
    const setLastDeg = vi.fn();
    const view = fakeView({ setLastDeg });
    const engine = mountTool(view);
    const t = engine.registry.getTool("run_deg")!;

    const result = await t.handler({ group: "B cells", topN: 1 }, ctx);

    // The server call always asks for the FULL_MARKER_COUNT, not topN=1.
    expect(runDegMock).toHaveBeenCalledWith("B cells", 100, ctx.signal);
    // The full ranked list reaches the store (DegPanel/chart), unshrunk by topN.
    expect(setLastDeg).toHaveBeenCalledWith(degResponse);
    expect((setLastDeg.mock.calls[0]![0] as DegResponse).markers).toHaveLength(100);
    // The transcript slice is bounded (never fewer than TRANSCRIPT_MARKERS=10) even though topN=1.
    expect(result).toMatchObject({ ok: true });
    if (result && typeof result === "object" && "data" in result) {
      const data = result.data as { markers: unknown[] };
      expect(data.markers.length).toBe(10);
    } else {
      throw new Error("expected a data field");
    }
  });

  it("returns {ok, message, data} instead of the old {success, message, ...} shape", async () => {
    const degResponse: DegResponse = {
      group: "T cells", reference: "rest", nCellsGroup: 5, nCellsReference: 50,
      markers: [marker("CD3D")], warning: null,
    };
    runDegMock.mockResolvedValue(degResponse);
    const engine = mountTool(fakeView());
    const t = engine.registry.getTool("run_deg")!;
    const result = await t.handler({ group: "T cells" }, ctx);
    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("data");
    expect(result).not.toHaveProperty("success");
  });

  it("reports failure as {ok: false, message} on a thrown error", async () => {
    runDegMock.mockRejectedValue(new Error("no such cluster"));
    const engine = mountTool(fakeView());
    const t = engine.registry.getTool("run_deg")!;
    const result = await t.handler({ group: "nonsense" }, ctx);
    expect(result).toEqual({ ok: false, message: "no such cluster" });
  });

  it("registers under the name run_deg, feature singlecell", () => {
    const engine = mountTool(fakeView());
    const t = engine.registry.getTool("run_deg");
    expect(t?.name).toBe("run_deg");
    expect(t?.group).toBe("singlecell");
  });
});
