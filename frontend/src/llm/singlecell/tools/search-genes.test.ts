// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { AI2UIProvider, useEngineContext } from "@bioturing-org/ai2ui";

const searchGenesMock = vi.fn();

vi.mock("../../../lib/api", () => ({
  searchGenes: (...args: unknown[]) => searchGenesMock(...args),
}));

// Imported after the mock above so `search-genes.ts` picks up the mocked module.
const { useSearchGenesTool } = await import("./search-genes");

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(AI2UIProvider, { gateway: { origin: "" }, user: null, children });

/**
 * Mounts `useSearchGenesTool` under a real provider and hands back the
 * engine it registered against, so a test can reach the tool through
 * `engine.registry.getTool(name)` — the same path the app uses — instead
 * of a standalone builder that no longer exists.
 */
function mountTool() {
  const { result } = renderHook(
    () => {
      useSearchGenesTool();
      return useEngineContext();
    },
    { wrapper },
  );
  return result.current.engine;
}

const ctx = { signal: new AbortController().signal, ask: {} as never };

beforeEach(() => {
  searchGenesMock.mockReset();
});

describe("search_genes", () => {
  it("registers under the name search_genes, feature singlecell", () => {
    const engine = mountTool();
    const t = engine.registry.getTool("search_genes");
    expect(t?.name).toBe("search_genes");
    expect(t?.group).toBe("singlecell");
  });

  it("returns matches when found", async () => {
    searchGenesMock.mockResolvedValue({ genes: [{ symbol: "CD3D" }, { symbol: "CD3E" }], total: 2, truncated: false });
    const engine = mountTool();
    const t = engine.registry.getTool("search_genes")!;
    const result = await t.handler({ q: "CD3" }, ctx);
    expect(result).toMatchObject({ ok: true });
  });

  it("returns ok:false with a hint when nothing matches", async () => {
    searchGenesMock.mockResolvedValue({ genes: [], total: 0, truncated: false });
    const engine = mountTool();
    const t = engine.registry.getTool("search_genes")!;
    const result = await t.handler({ q: "ZZZZZ" }, ctx);
    expect(result).toMatchObject({ ok: false });
    if (result && typeof result === "object" && "hint" in result) {
      expect(typeof result.hint).toBe("string");
    }
  });
});
