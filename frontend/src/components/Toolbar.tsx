/**
 * Dataset name, current colour-mode indicator, ramp toggle, and Reset.
 * Reset calls `colorByCluster()` — the same store action a "reset view" LLM
 * tool would call later, so there is exactly one way to get back to cluster
 * colouring.
 */
import { useDatasetStore } from "../state/useDatasetStore";
import { useViewStore } from "../state/useViewStore";
import { RampControl } from "./RampControl";
// import { ClearChatButton } from "./ClearChatButton";

export function Toolbar() {
  const { data } = useDatasetStore();
  const { colorMode, genes, colorByCluster } = useViewStore();

  const modeLabel =
    colorMode === "expression" && genes.length > 0
      ? `Expression: ${genes.map((g) => g.gene).join(", ")}`
      : "Cluster colors";

  return (
    <div className="toolbar">
      <div className="toolbar-dataset">{data?.dataset ?? "single-cell dataset"}</div>
      <div className="toolbar-mode" aria-live="polite">
        {modeLabel}
      </div>
      <div className="toolbar-spacer" />
      {/* Only meaningful in expression mode — in cluster mode the ramp isn't
          driving anything, so showing it would be a dead control. */}
      {colorMode === "expression" && genes.length > 0 && <RampControl />}
      {/* <ClearChatButton /> */}
      {/* "Reset" clears the VIEW; "Clear chat" clears the CONVERSATION. */}
      <button type="button" className="toolbar-reset" onClick={colorByCluster}>
        Reset view
      </button>
    </div>
  );
}
