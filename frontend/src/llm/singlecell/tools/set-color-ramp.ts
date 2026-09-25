/**
 * `set_color_ramp` — switches the expression colour scale between the default
 * grey→red and viridis. Pure client state: no fetch, no recomputation, just
 * the store action the toolbar's own swatch control calls.
 *
 * Registered straight through `useTool` — no separate builder function.
 * `set-color-ramp.test.ts` reaches the handler by mounting this hook under
 * a real `AI2UIProvider` and pulling the tool back out of the engine's
 * registry, the same way the app itself reaches it.
 */
import { z } from "zod";
import { useTool } from "@bioturing-org/ai2ui";
import type { ViewStore } from "../../../state/useViewStore";

const params = z.object({
  ramp: z
    .enum(["expression", "viridis"])
    .describe(
      "Which colour scale to use. 'expression' is the default grey→red " +
        "(zero-expression cells recede to light grey); 'viridis' is the " +
        "perceptually-uniform blue→green→yellow scale many people expect " +
        "from scanpy.",
    ),
});

export const useSetColorRampTool = (view: ViewStore): void => {
  useTool(
    {
      name: "set_color_ramp",
      group: "singlecell",
      description:
        "Change the colour scale used to draw gene expression. Only affects " +
        "expression mode; it does nothing to cluster colours, which are a " +
        "fixed categorical palette.",
      params,
      handler: async ({ ramp }) => {
        try {
          const previousRamp = view.ramp;
          view.setRamp(ramp);
          const label = ramp === "viridis" ? "viridis" : "grey → red";
          // Report, don't refuse: switching the ramp while in cluster mode is
          // harmless and takes effect on the next gene, but the user would
          // otherwise see nothing happen and think the tool failed.
          const note =
            view.colorMode === "cluster"
              ? " (no visible change yet — the scatter is showing cluster colours; it will apply to the next gene displayed)"
              : "";
          return { ok: true as const, message: `Colour ramp set to ${label}${note}.`, data: { ramp, previousRamp } };
        } catch (e) {
          return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    [view],
  );
};
