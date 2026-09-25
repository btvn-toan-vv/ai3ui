/**
 * `color_by_cluster` — resets the scatter to categorical (cluster) colouring
 * and clears the displayed genes. Takes no parameters.
 *
 * Registered straight through `useTool` — no separate builder function.
 * `color-by-cluster.test.ts` reaches the handler by mounting this hook
 * under a real `AI2UIProvider` and pulling the tool back out of the
 * engine's registry, the same way the app itself reaches it.
 */
import { z } from "zod";
import { useTool } from "@bioturing-org/ai2ui";
import type { ViewStore } from "../../../state/useViewStore";

const params = z.object({});

export const useColorByClusterTool = (view: ViewStore): void => {
  useTool(
    {
      name: "color_by_cluster",
      group: "singlecell",
      description: "Reset the scatter plot to categorical cluster colouring and clear any displayed genes.",
      params,
      handler: async () => {
        try {
          view.colorByCluster();
          return { ok: true as const, message: "Scatter reset to cluster colours." };
        } catch (e) {
          return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    [view],
  );
};
