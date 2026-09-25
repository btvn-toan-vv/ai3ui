/**
 * `query_genes` — puts gene expression on screen.
 *
 * MUST go through `displayGenes` (`src/lib/geneDisplay.ts`), the single
 * fetch-then-store path shared with the manual gene box (`GenePanel`) and
 * the DEG table (`DegPanel`).
 *
 * Registered straight through `useTool` — no separate builder function.
 * `query-genes.test.ts` reaches the handler by mounting this hook under a
 * real `AI2UIProvider` and pulling the tool back out of the engine's
 * registry, the same way the app itself reaches it.
 */
import { z } from "zod";
import { useTool } from "@bioturing-org/ai2ui";
import { displayGenes } from "../../../lib/geneDisplay";
import { MAX_GENES } from "../../../lib/constants";
import type { GeneVector } from "../../../lib/types";
import type { ViewStore } from "../../../state/useViewStore";

const params = z.object({
  // Deliberately NOT capped here. It used to say "up to 4", which made the
  // model quietly truncate a 10-gene request to 4 and say nothing — the
  // user asked for ten genes and got four with no explanation. Now the
  // model passes everything the user asked for; the handler enforces the
  // real cap and explains itself, and `maxGenesAtOnce` in the ground-truth
  // context (see ../context.ts) tells the model the limit before it has a
  // chance to violate it.
  genes: z
    .array(z.string())
    .min(1)
    .describe(
      "Every HGNC gene symbol the user asked for, e.g. ['CD3D', 'MS4A1'] — " +
        "do NOT pre-truncate this list yourself. Use search_genes first if " +
        "unsure a symbol exists.",
    ),
});

export const useQueryGenesTool = (view: ViewStore): void => {
  useTool(
    {
      name: "query_genes",
      group: "singlecell",
      description:
        "Show gene expression on the scatter plot (switches colour mode to " +
        "expression). Pass every gene the user named — if there are more than " +
        `${MAX_GENES} the tool will refuse and say so, so ask which matter most ` +
        "rather than sending an over-long list.",
      params,
      handler: async ({ genes: requested }, { signal }) => {
        try {
          const cleaned = requested.map((s) => s.trim()).filter((s) => s.length > 0);
          if (cleaned.length === 0) {
            return { ok: false as const, message: "No gene symbols were given.", hint: "Ask the user which gene(s) they want to see." };
          }
          if (cleaned.length > MAX_GENES) {
            return {
              ok: false as const,
              message: `Only ${MAX_GENES} genes can be drawn at once (one scatter panel each); ${cleaned.length} were requested.`,
              hint: `Ask the user which ${MAX_GENES} matter most, or call query_genes again with at most ${MAX_GENES} symbols.`,
            };
          }

          let shown: GeneVector[] | null = null;
          let errorMsg: string | null = null;

          await displayGenes(
            cleaned,
            view.genes,
            {
              showGenes: (g) => { shown = g; view.showGenes(g); },
              setError: (e) => { errorMsg = e; view.setError(e); },
            },
            signal,
          );

          // `displayGenes` itself rejects (via setError) if merging with what's
          // already on screen would still exceed the cap — `shown` stays null
          // in that case, same as a network failure.
          if (!shown) {
            return { ok: false as const, message: errorMsg ?? "Request was cancelled before any genes could be shown." };
          }

          const requestedUpper = new Set(cleaned.map((s) => s.toUpperCase()));
          const shownList = shown as GeneVector[];
          const found = shownList.filter((g) => requestedUpper.has(g.gene.toUpperCase()));
          const shownUpper = new Set(shownList.map((g) => g.gene.toUpperCase()));
          const notFound = [...requestedUpper].filter((u) => !shownUpper.has(u));

          if (found.length === 0) {
            return {
              ok: false as const,
              message: `None of these symbols exist: ${notFound.join(", ")}.`,
              hint: "Use search_genes to find the right symbol.",
            };
          }

          return {
            ok: true as const,
            message:
              `${found.map((r) => `${r.gene} — ${r.values.length} values, range ${r.min.toFixed(2)}–${r.max.toFixed(2)}`).join("; ")}` +
              (notFound.length ? `. Not found: ${notFound.join(", ")}` : ""),
            data: { shown: found.map((f) => f.gene), notFound },
          };
        } catch (e) {
          return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
        }
      },
      // No `render` — the default tool-call card handles this one.
    },
    [view],
  );
};
