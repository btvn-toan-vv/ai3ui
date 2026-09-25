/**
 * The one hook for this feature: `useSingleCell()`. Calls each tool's own
 * `use*Tool` hook (`./tools/*`) plus the two context hooks (`./context.ts`).
 * `App.tsx` calls this once, inside `<AI2UIProvider>` (each `use*Tool`/
 * `use*Context` call needs `useEngineContext()`, which throws outside the
 * provider — see `@bioturing-org/ai2ui`'s `provider.tsx`).
 *
 * `useTool`/`useContext` are now the only way to register — there is no
 * `tools`/`context` prop on `AI2UIProvider` to hand a pre-built array to,
 * so nothing here builds an array; each tool/context slice registers
 * itself via its own hook call, the same way the library's own tests
 * register a tool (see `@bioturing-org/ai2ui`'s `hooks/tests/provider.test.tsx`).
 *
 * `clusters` is memoized on `data` alone (not recomputed as a fresh array
 * every render) so `useHighlightClustersTool` only re-registers when the
 * dataset actually changes, not on every keystroke elsewhere in the view
 * state.
 */
import { useMemo } from "react";
import { useDatasetStore } from "../../state/useDatasetStore";
import { useViewStore } from "../../state/useViewStore";
import { useRunDegTool } from "./tools/run-deg";
import { useQueryGenesTool } from "./tools/query-genes";
import { useColorByClusterTool } from "./tools/color-by-cluster";
import { useSearchGenesTool } from "./tools/search-genes";
import { useHighlightClustersTool } from "./tools/highlight-clusters";
import { useSetColorRampTool } from "./tools/set-color-ramp";
import { useSingleCellGroundTruthContext, useDomainContext } from "./context";

export function useSingleCell(): void {
  const view = useViewStore();
  const { data } = useDatasetStore();
  const clusters = useMemo(() => data?.clusters ?? [], [data]);

  useRunDegTool(view);
  useQueryGenesTool(view);
  useColorByClusterTool(view);
  useSearchGenesTool();
  useHighlightClustersTool(view, clusters);
  useSetColorRampTool(view);

  useSingleCellGroundTruthContext(view, data);
  useDomainContext();
}
