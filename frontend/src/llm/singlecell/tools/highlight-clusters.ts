/**
 * `highlight_clusters` — the pure-UI tool. NO network request: it only
 * calls `setHighlight`, client state that dims every cluster not named here
 * to ~15% opacity. Cluster labels are resolved leniently (case/whitespace-
 * insensitive exact match, falling back to substring match against every
 * cluster label so e.g. "monocytes" picks up both "CD14+ Monocytes" and
 * "FCGR3A+ Monocytes"); anything left unmatched is reported back in the
 * message instead of silently dropped.
 *
 * Registered straight through `useTool` — no separate builder function.
 * `highlight-clusters.test.ts` reaches the handler by mounting this hook
 * under a real `AI2UIProvider` and pulling the tool back out of the
 * engine's registry, the same way the app itself reaches it.
 */
import { z } from "zod";
import { useTool } from "@bioturing-org/ai2ui";
import type { ClusterInfo } from "../../../lib/types";
import type { ViewStore } from "../../../state/useViewStore";

const params = z.object({
  clusters: z.array(z.string()).describe("Cluster labels to highlight; every other cluster dims. Pass an empty array to clear highlighting."),
});

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

export const useHighlightClustersTool = (view: ViewStore, clusters: ClusterInfo[]): void => {
  useTool(
    {
      name: "highlight_clusters",
      group: "singlecell",
      description: "Highlight one or more clusters on the scatter plot by dimming everything else. Pure client-side state, no network request.",
      params,
      handler: async ({ clusters: requested }) => {
        try {
          if (requested.length === 0) {
            view.setHighlight(null);
            return { ok: true as const, message: "Highlight cleared; all clusters at full opacity." };
          }

          const resolved = new Set<string>();
          const unmatched: string[] = [];

          for (const name of requested) {
            const target = normalizeLabel(name);
            const exact = clusters.find((c) => normalizeLabel(c.label) === target);
            if (exact) { resolved.add(exact.label); continue; }
            const partial = clusters.filter((c) => normalizeLabel(c.label).includes(target));
            if (partial.length > 0) partial.forEach((c) => resolved.add(c.label));
            else unmatched.push(name);
          }

          if (resolved.size === 0) {
            const validLabels = clusters.map((c) => c.label).join(", ");
            return { ok: false as const, message: `No cluster labels matched: ${unmatched.join(", ")}.`, hint: `Valid labels: ${validLabels}` };
          }

          const resolvedClusters = Array.from(resolved);
          view.setHighlight(resolvedClusters);
          return {
            ok: true as const,
            message: `Highlighted ${resolvedClusters.join(", ")}${unmatched.length ? `. Unmatched: ${unmatched.join(", ")}` : ""}`,
            data: { clusters: resolvedClusters },
          };
        } catch (e) {
          return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    [view, clusters],
  );
};
