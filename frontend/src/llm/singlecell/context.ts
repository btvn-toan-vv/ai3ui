/**
 * The two context slices for this feature, registered via `@bioturing-org/ai2ui`'s
 * `useContext` hook. `defineContext` is deleted — a `ContextDefinition` is
 * now just a plain object, the same shape the library's own built-ins use.
 *
 * This file never needs React's own `useContext` (no other context is read
 * here), so the import below is not aliased. A file that needs both would
 * need to alias one of them — see `@bioturing-org/ai2ui`'s `use-context.ts`.
 *
 * Two slices:
 *
 * - `singlecell-ground-truth` (`volatile: true`) — the same value shape as
 *   the old readable, recomputed on every call. What is deliberately IN
 *   here: everything a user can point at and say "that". If you can see it
 *   on screen, the model must be able to answer a question about it without
 *   calling a tool — which colour a cluster is, whether a gene is in the
 *   marker list, what is dimmed, which ramp is active. What is deliberately
 *   OUT: the 13,714-gene catalog and any expression vector — that's what
 *   `search_genes` and `query_genes` are for.
 *
 *   Its `description` DROPS the old "STATE BEATS HISTORY" / "recomputed and
 *   resent" paragraphs — `src/server/ai2ui/prompt.ts`'s FROZEN zone already
 *   carries that rule for every app built on this gateway (see its own
 *   "STATE BEATS HISTORY" section), so repeating it per-context-slice would
 *   just be the same instruction twice.
 *
 * - `domain` (`volatile: false`) — the half of the old
 *   `src/server/llm.ts#SYSTEM_PROMPT` that is genuinely about THIS dataset
 *   (exact cell-type labels, the two T-cell and two monocyte populations,
 *   HGNC symbols, the run_deg -> query_genes sequence, log2FC/FDR
 *   reporting), not about tool-use mechanics in general. The generic half
 *   (one tool at a time, {ok,message,...} result shape, state beats
 *   history, when to ask) is already in the gateway's FROZEN preamble —
 *   see `prompt.ts` — so it is not duplicated here.
 *
 * Neither slice has a standalone builder any more — each hook builds its
 * own `ContextDefinition` inline and hands it straight to `useContext`.
 * `context.test.ts` reaches a slice by mounting the hook under a real
 * `AI2UIProvider` and reading it back off `engine.registry.contextSlices()`.
 */
import { useContext, type ContextDefinition } from "@bioturing-org/ai2ui";
import { MAX_GENES } from "../../lib/constants";
import type { DatasetResponse } from "../../lib/types";
import { clusterColor } from "../../lib/colors";
import type { ViewStore } from "../../state/useViewStore";

const hex = (rgb: [number, number, number]) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

/** Plain-language names so the model can say "the blue cluster", not "#0072b2". */
const COLOR_NAMES = ["blue", "orange", "green", "vermillion", "pink", "sky blue", "yellow", "brown", "magenta", "violet", "olive", "sage"];

/**
 * Deps are the raw `view`/`data` objects, not their derived fields —
 * matches the original factory's memoization: `view`'s identity changes
 * exactly when any piece of view state changes (see `useViewStore.ts`), and
 * `data`'s identity changes only when the dataset reloads. Using those two
 * objects as the dependency list (instead of every derived field
 * individually) means this context slice is rebuilt exactly when something
 * it could report on actually changed, and never more often.
 */
export const useSingleCellGroundTruthContext = (view: ViewStore, data: DatasetResponse | null): void => {
  const { colorMode, genes, lastDeg, highlighted, ramp } = view;
  const clusters = data?.clusters ?? [];

  // Cluster identity + the colour it is actually drawn in, so "what colour
  // are the B cells?" and "highlight the orange one" both work without a
  // tool call.
  const clusterRows = clusters.map((c) => ({
    label: c.label,
    nCells: c.nCells,
    color: hex(clusterColor(c.id)),
    colorName: COLOR_NAMES[c.id % COLOR_NAMES.length],
    dimmed: highlighted ? !highlighted.includes(c.label) : false,
  }));

  const displayedGenes = genes.map((g) => ({ gene: g.gene, min: g.min, max: g.max, pctExpressing: g.pctExpressing }));

  const lastDegSummary = lastDeg
    ? {
        group: lastDeg.group,
        reference: lastDeg.reference,
        nCellsGroup: lastDeg.nCellsGroup,
        totalMarkers: lastDeg.markers.length,
        warning: lastDeg.warning,
        // Full symbol list: needed to answer "is GZMB in the marker list?"
        // without re-running DEG. Symbols only — stats stay on the top 10.
        allMarkerGenes: lastDeg.markers.map((m) => m.gene),
        top10: lastDeg.markers.slice(0, 10).map((m) => ({
          gene: m.gene,
          log2fc: Number(m.log2fc.toFixed(2)),
          fdr: m.fdr,
          pctIn: Number(m.pctIn.toFixed(3)),
          pctOut: Number(m.pctOut.toFixed(3)),
        })),
      }
    : null;

  useContext(
    {
      key: "singlecell-ground-truth",
      description:
        "GROUND TRUTH — exactly what the single-cell viewer is showing right now. " +
        "If the user says 'it', 'that gene', 'the highlighted ones' or 'that colour', resolve it from here.",
      volatile: true,
      value: JSON.stringify({
        dataset: "pbmc3k — 2,638 human PBMCs, log1p-normalized",
        nCells: data?.nCells ?? null,
        nGenes: data?.nGenes ?? null,

        // --- what the map is currently drawing ---
        colorMode,
        colorRamp:
          colorMode === "expression"
            ? ramp === "viridis"
              ? "viridis (dark blue = low, yellow = high)"
              : "grey → red (light grey = zero, dark red = high)"
            : "categorical cluster palette (see clusters[].color)",
        clusters: clusterRows,

        // --- genes on screen ---
        displayedGenes,
        displayedGeneCount: genes.length,
        maxGenesAtOnce: MAX_GENES,

        // --- highlight state ---
        highlightedClusters: highlighted,
        highlightActive: !!highlighted,

        // --- marker table contents ---
        lastDeg: lastDegSummary,

        notes: [
          `13,714 genes exist; only the ${genes.length} in displayedGenes are drawn. Use search_genes to check a symbol before querying it — do not guess.`,
          `At most ${MAX_GENES} genes can be shown at once (the scatter renders one panel each). If the user asks for more, say so BEFORE calling query_genes and offer to show the ${MAX_GENES} most relevant.`,
          "lastDeg.allMarkerGenes is the complete marker list for the current table — check membership there instead of re-running run_deg.",
        ],
      }),
    },
    [view, data],
  );
};

/**
 * Static: nothing here depends on live app state, so unlike the ground-truth
 * slice this is a plain module-level constant, built once. It has no
 * builder to delete — the constant IS the definition, and the hook below
 * just registers it.
 */
export const domainContext: ContextDefinition = {
  key: "domain",
  description: "Domain knowledge for this single-cell RNA-seq viewer — how to interpret cell-type and gene requests correctly. Not app state; see singlecell-ground-truth for that.",
  volatile: false,
  value: [
    "Cell type labels are exact strings from the cluster list in the singlecell-ground-truth context — use them verbatim.",
    "There are two T cell populations (CD4 and CD8) and two monocyte populations (CD14+ and FCGR3A+). If the user says \"T cells\" or \"monocytes\" without qualifying, pick ONE (say which one and mention the other population exists) rather than running the analysis on both. When the ambiguity changes what you would do and it is not already clear which one they mean, use ask_user with a kind \"select\" question whose options are the specific labels, instead of guessing.",
    "Gene symbols are HGNC (CD3D, MS4A1, LYZ). If you are not certain a symbol exists, call search_genes first.",
    "If the user asks which/what gene is the top marker for a cell type, that is a request to SEE it, not just hear about it. Required sequence: call run_deg, say one sentence naming the marker you picked, then IMMEDIATELY call query_genes on that exact gene in your next turn — automatically, without asking \"would you like me to visualize this?\" and without waiting for the user to say yes. Only skip the query_genes call if the user explicitly asked for numbers/text only.",
    "When you report a marker, give its log2FC and FDR, and mention pctIn/pctOut when they undercut the result (a high fold-change expressed in 8% of cells is weak). Relay any warning field verbatim.",
  ].join("\n\n"),
};

export const useDomainContext = (): void => {
  useContext(domainContext, []);
};
