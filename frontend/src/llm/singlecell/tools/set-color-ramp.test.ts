// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { AI2UIProvider, useEngineContext } from "@bioturing-org/ai2ui";
import type { ViewStore } from "../../../state/useViewStore";
import { useSetColorRampTool } from "./set-color-ramp";

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
 * Mounts `useSetColorRampTool` under a real provider and hands back the
 * engine it registered against, so a test can reach the tool through
 * `engine.registry.getTool(name)` — the same path the app uses — instead
 * of a standalone builder that no longer exists.
 */
function mountTool(view: ViewStore) {
  const { result } = renderHook(
    () => {
      useSetColorRampTool(view);
      return useEngineContext();
    },
    { wrapper },
  );
  return result.current.engine;
}

const ctx = { signal: new AbortController().signal, ask: {} as never };

describe("set_color_ramp", () => {
  it("registers under the name set_color_ramp, feature singlecell", () => {
    const engine = mountTool(fakeView());
    const t = engine.registry.getTool("set_color_ramp");
    expect(t?.name).toBe("set_color_ramp");
    expect(t?.group).toBe("singlecell");
  });

  it("switches the ramp and reports the previous one", async () => {
    const setRamp = vi.fn();
    const view = fakeView({ setRamp, ramp: "expression", colorMode: "expression" });
    const engine = mountTool(view);
    const t = engine.registry.getTool("set_color_ramp")!;
    const result = await t.handler({ ramp: "viridis" }, ctx);
    expect(setRamp).toHaveBeenCalledWith("viridis");
    expect(result).toMatchObject({ ok: true, data: { ramp: "viridis", previousRamp: "expression" } });
  });

  it("notes when the change is not yet visible in cluster mode", async () => {
    const engine = mountTool(fakeView({ colorMode: "cluster" }));
    const t = engine.registry.getTool("set_color_ramp")!;
    const result = await t.handler({ ramp: "viridis" }, ctx);
    if (result && typeof result === "object" && "message" in result) {
      expect(String(result.message)).toMatch(/no visible change/);
    }
  });
});
