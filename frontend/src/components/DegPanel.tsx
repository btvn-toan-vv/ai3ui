/**
 * DEG marker table. Reads `useViewStore().lastDeg` — populated either by the
 * "Run DEG" control below (manual path, this task) or by the LLM's
 * `run_deg` tool (Task 14). Holds the full ~100 markers the server returns;
 * the LLM tool result later carries only ~10, but this panel always shows
 * everything the last run produced.
 *
 * Clicking a row calls `displayGenes` — the SAME fetch-then-store path
 * `GenePanel`'s input box uses. There is no second "show this gene" path.
 */
import { useEffect, useState } from "react";
import { useDatasetStore } from "../state/useDatasetStore";
import { useViewStore } from "../state/useViewStore";
import { runDeg } from "../lib/api";
import { displayGenes } from "../lib/geneDisplay";
import { formatFixed, formatPercent, formatScientific } from "../lib/format";

export function DegPanel() {
  const { data } = useDatasetStore();
  const { genes, lastDeg, showGenes, setLastDeg, setError } = useViewStore();
  // Empty string means "no explicit user choice yet". `data` is still null on
  // the very first render (the fetch in useDatasetStore runs in an effect),
  // so this can't be seeded from `data?.clusters[0]` at useState-init time —
  // that closure only runs once, before the dataset has loaded, and would
  // permanently lock `group` to "" while the <select> visually falls back to
  // showing its first <option> anyway (misleading: state and display would
  // disagree). Falling back to `clusters[0]` at render/use time instead
  // keeps both in sync once the dataset arrives.
  const [group, setGroup] = useState<string>("");
  const [running, setRunning] = useState(false);

  const clusters = data?.clusters ?? [];
  const effectiveGroup = group || clusters[0]?.label || "";

  // Follow whatever produced the table currently on screen — including a
  // `run_deg` the LLM issued from chat. Without this the picker keeps showing
  // its own stale choice while the table below it shows the agent's group,
  // and the two controls disagree about what you are looking at.
  //
  // Keyed on `lastDeg.group` (not the object) so re-running the same group
  // does not fight a selection the user is in the middle of making.
  const lastDegGroup = lastDeg?.group;
  useEffect(() => {
    if (lastDegGroup) setGroup(lastDegGroup);
  }, [lastDegGroup]);

  // True while the picker names a different group than the table shows — i.e.
  // the user has chosen something they have not run yet.
  const pendingChange = !!lastDeg && effectiveGroup !== lastDeg.group;

  const handleRun = async () => {
    if (!effectiveGroup) {
      setError("Pick a cluster to run DEG against.");
      return;
    }
    setRunning(true);
    try {
      const result = await runDeg(effectiveGroup);
      setLastDeg(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const handleRowClick = (gene: string) => {
    void displayGenes([gene], genes, { showGenes, setError });
  };

  return (
    <div className="deg-panel">
      <div className="deg-panel-controls">
        <select
          value={effectiveGroup}
          onChange={(e) => setGroup(e.target.value)}
          aria-label="Cluster to run DEG against"
        >
          {clusters.map((c) => (
            <option key={c.id} value={c.label}>
              {c.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`deg-run-button${pendingChange ? " is-pending" : ""}`}
          onClick={() => void handleRun()}
          disabled={running}
        >
          {running ? "Running…" : "Run DEG"}
        </button>
      </div>

      {lastDeg?.warning && <div className="deg-panel-warning">{lastDeg.warning}</div>}

      {lastDeg ? (
        <div className="deg-table-wrap">
          <table className="deg-table">
            <caption>
              {lastDeg.group} ({lastDeg.nCellsGroup.toLocaleString("en-US")} cells) vs.{" "}
              {lastDeg.reference} ({lastDeg.nCellsReference.toLocaleString("en-US")} cells)
            </caption>
            <thead>
              <tr>
                <th>Gene</th>
                <th>log2FC</th>
                <th>FDR</th>
                <th>% in</th>
                <th>% out</th>
              </tr>
            </thead>
            <tbody>
              {lastDeg.markers.map((m) => (
                <tr key={m.gene}>
                  <td>
                    <button
                      type="button"
                      className="deg-table-gene-button"
                      onClick={() => handleRowClick(m.gene)}
                    >
                      {m.gene}
                    </button>
                  </td>
                  <td>{formatFixed(m.log2fc)}</td>
                  <td>{formatScientific(m.fdr)}</td>
                  <td>{formatPercent(m.pctIn)}</td>
                  <td>{formatPercent(m.pctOut)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="deg-panel-empty">Run a DEG comparison to see marker genes.</div>
      )}
    </div>
  );
}
