/**
 * `search_genes` — lets the model check whether a symbol exists (and find
 * the right one) before calling `query_genes`, instead of hallucinating a
 * symbol. Backed by `GET /api/genes?q=`, which never returns the full
 * 13,714-symbol catalog.
 *
 * Registered straight through `useTool` — no separate builder function.
 * Stateless — it closes over no app state, so its registration deps are
 * empty. `search-genes.test.ts` reaches the handler by mounting this hook
 * under a real `AI2UIProvider` and pulling the tool back out of the
 * engine's registry, the same way the app itself reaches it.
 */
import { z } from "zod";
import { useTool } from "@bioturing-org/ai2ui";
import { searchGenes } from "../../../lib/api";

const params = z.object({
  q: z.string().describe("Gene symbol or substring to search for, e.g. 'MS4A' or 'CD3'."),
});

export const useSearchGenesTool = (): void => {
  useTool(
    {
      name: "search_genes",
      group: "singlecell",
      description: "Search the 13,714-gene catalog for symbols matching a query. Use this before query_genes if unsure a symbol exists.",
      params,
      handler: async ({ q }, { signal }) => {
        try {
          const res = await searchGenes(q, signal);
          const top = res.genes.slice(0, 10).map((g) => g.symbol);
          return res.genes.length
            ? { ok: true as const, message: `${res.total}${res.truncated ? "+" : ""} match(es) for "${q}": ${top.join(", ")}`, data: { genes: top } }
            : { ok: false as const, message: `No gene symbols match "${q}".`, hint: "Try a shorter substring or a different symbol." };
        } catch (e) {
          return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    [],
  );
};
