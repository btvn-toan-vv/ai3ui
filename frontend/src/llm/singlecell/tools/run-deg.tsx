/**
 * `run_deg` — the LLM's entry point into differential expression.
 *
 * Computation happens server-side (`POST /api/run_deg`); this registers the
 * tool the browser sees `TOOL_CALL_*` events for and renders a chart from.
 *
 * The server returns ~100 markers. Only a bounded slice goes back through
 * the transcript (the model re-reads every tool result on every subsequent
 * turn); the full set is written to `view.setLastDeg` for `DegPanel` to
 * render.
 *
 * Registered straight through `useTool` — no separate builder function.
 * `run-deg.test.ts` reaches the handler by mounting this hook under a real
 * `AI2UIProvider` and pulling the tool back out of the engine's registry,
 * the same way the app itself reaches it.
 */
import { z } from "zod";
import { useTool, ToolCallCard } from "@bioturing-org/ai2ui";
import { MarkerChart } from "../../../components/MarkerChart";
import { runDeg } from "../../../lib/api";
import { displayGenes } from "../../../lib/geneDisplay";
import { FULL_MARKER_COUNT, TRANSCRIPT_MARKERS } from "../../../lib/constants";
import type { Marker } from "../../../lib/types";
import type { ViewStore } from "../../../state/useViewStore";

const params = z.object({
  group: z
    .string()
    .describe("Exact cell type label from the cluster list, e.g. 'CD4 T cells'. Resolved leniently server-side."),
  topN: z
    .number()
    .optional()
    .describe(
      "How many markers to REPORT back to you in the result. This does not " +
        "limit what the user sees — the marker table always fills with the " +
        "full ranked list regardless. Omit unless the user asked for a " +
        "specific number.",
    ),
});

export const useRunDegTool = (view: ViewStore): void => {
  useTool(
    {
      name: "run_deg",
      group: "singlecell",
      description: "Find marker genes for a cell type versus all other cells (differential expression).",
      params,
      handler: async ({ group, topN }, { signal }) => {
        try {
          // Always compute the FULL list, whatever `topN` the model chose. It
          // used to pass topN straight through, so "what's the top marker in B
          // cells?" made the model request topN=1 — and the marker table the
          // user is looking at filled with exactly one row. The panel is the
          // user's view, not the model's; its contents should not shrink
          // because of how the question was phrased.
          const deg = await runDeg(group, FULL_MARKER_COUNT, signal);
          view.setLastDeg(deg); // full ranked list -> DegPanel + chart

          // The transcript gets a bounded slice — the model re-reads every
          // tool result on every later turn, so 100 rows x 6 fields would be
          // ~3k tokens of dead weight per turn. Never fewer than 10, so the
          // in-chat chart stays worth drawing even if the model asked for 1.
          const reportCount = Math.min(Math.max(topN ?? TRANSCRIPT_MARKERS, TRANSCRIPT_MARKERS), 25);

          return {
            ok: true as const,
            message:
              `${deg.markers.length} markers for ${deg.group} (${deg.nCellsGroup} cells vs ${deg.nCellsReference}). ` +
              `The full ranked table is on screen; the top ${reportCount} are below.` +
              (deg.warning ? ` ${deg.warning}` : ""),
            data: { group: deg.group, warning: deg.warning, markers: deg.markers.slice(0, reportCount) },
          };
        } catch (e) {
          return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
        }
      },
      render: (props) => {
        const argsRaw = JSON.stringify(props.args ?? {});
        const isSettled = props.status === "complete" || props.status === "failed";
        const resultRaw = isSettled ? props.raw : undefined;

        let markers: Marker[] = [];
        let group = "";
        if (isSettled && props.result.ok && props.result.data && typeof props.result.data === "object") {
          const data = props.result.data as { group?: unknown; markers?: unknown };
          if (Array.isArray(data.markers)) markers = data.markers as Marker[];
          if (typeof data.group === "string") group = data.group;
        }

        return (
          <>
            <ToolCallCard
              id="run_deg"
              name="run_deg"
              status={props.status}
              argsRaw={argsRaw}
              resultRaw={resultRaw}
              isLast={false}
            />
            {markers.length > 0 && (
              <MarkerChart
                markers={markers}
                group={group}
                onSelectGene={(gene) => void displayGenes([gene], view.genes, { showGenes: view.showGenes, setError: view.setError })}
              />
            )}
          </>
        );
      },
    },
    [view],
  );
};
