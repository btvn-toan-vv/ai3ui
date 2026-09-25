/**
 * Cluster mode legend: swatch + label + cell count per cluster.
 *
 * Rendered as a compact overlay in the scatter's top-left corner rather than
 * a side column — a fixed legend column costs ~220px of horizontal space
 * permanently, which the scatter needs more than the legend does.
 *
 * Collapsible: collapsed it is a single strip of swatches (still readable as
 * "these are the 8 groups and their colours"), expanded it lists labels and
 * counts. Collapsed is a deliberate non-default — the labels matter on first
 * look, so it starts open.
 *
 * Clicking an entry calls `setHighlight` — the SAME store action the LLM's
 * `highlight_clusters` tool will call later (Task 14+). There is no separate
 * "UI highlight" path; if there were, the manual click and the agent tool
 * could disagree about what's highlighted.
 *
 * @format
 */

import { useState } from "react";
import type { ClusterInfo } from "../lib/types";
import { clusterColor } from "../lib/colors";

export interface ClusterLegendProps {
  clusters: ClusterInfo[];
  highlighted: string[] | null;
  setHighlight: (c: string[] | null) => void;
}

export function ClusterLegend({
  clusters,
  highlighted,
  setHighlight,
}: ClusterLegendProps) {
  const [open, setOpen] = useState(true);

  const handleClick = (label: string) => {
    const isSoleHighlight =
      !!highlighted && highlighted.length === 1 && highlighted[0] === label;
    setHighlight(isSoleHighlight ? null : [label]);
  };

  return (
    <div className={`cluster-legend${open ? "" : " is-collapsed"}`}>
      <div className="cluster-legend-head">
        <button
          type="button"
          className="cluster-legend-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span
            className="cluster-legend-chevron"
            aria-hidden="true"
          >
            {open ? "-" : "+"}
          </span>
          <span>{clusters.length} clusters</span>
        </button>
        {highlighted && (
          <button
            type="button"
            className="cluster-legend-clear"
            onClick={() => setHighlight(null)}
          >
            Clear
          </button>
        )}
      </div>

      {open ? (
        <ul
          className="cluster-legend-list"
          aria-label="Cluster legend"
        >
          {clusters.map((c) => {
            const [r, g, b] = clusterColor(c.id);
            const dimmed = !!highlighted && !highlighted.includes(c.label);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className={`cluster-legend-entry${dimmed ? " is-dimmed" : ""}`}
                  onClick={() => handleClick(c.label)}
                  aria-pressed={!!highlighted?.includes(c.label)}
                  title={`${c.label} — ${c.nCells.toLocaleString("en-US")} cells`}
                >
                  <span
                    className="cluster-legend-swatch"
                    style={{ backgroundColor: `rgb(${r}, ${g}, ${b})` }}
                    aria-hidden="true"
                  />
                  <span className="cluster-legend-label">{c.label}</span>
                  <span className="cluster-legend-count">
                    {c.nCells.toLocaleString("en-US")}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        /* Collapsed: the colour mapping survives even without labels, so the
           scatter stays interpretable at a glance. Each swatch keeps its own
           click target and tooltip. */
        <ul
          className="cluster-legend-strip"
          aria-label="Cluster legend (collapsed)"
        >
          {clusters.map((c) => {
            const [r, g, b] = clusterColor(c.id);
            const dimmed = !!highlighted && !highlighted.includes(c.label);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className={`cluster-legend-dot${dimmed ? " is-dimmed" : ""}`}
                  style={{ backgroundColor: `rgb(${r}, ${g}, ${b})` }}
                  onClick={() => handleClick(c.label)}
                  aria-pressed={!!highlighted?.includes(c.label)}
                  aria-label={`${c.label} — ${c.nCells.toLocaleString("en-US")} cells`}
                  title={`${c.label} — ${c.nCells.toLocaleString("en-US")} cells`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
