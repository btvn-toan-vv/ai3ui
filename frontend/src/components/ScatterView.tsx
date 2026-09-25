/**
 * Top-level scatter view: wires `useDatasetStore` + `useViewStore` into
 * `ScatterPanel` instances, plus the cluster legend / expression colorbars.
 *
 * `genes.length <= 1` renders one panel filling the area (cluster mode
 * always takes this branch, since `colorByCluster` clears `genes`).
 * `genes.length > 1` renders a small-multiples grid, one panel + one
 * independently-scaled colorbar per gene.
 */
import { useMemo } from "react";
import { useDatasetStore } from "../state/useDatasetStore";
import { useViewStore } from "../state/useViewStore";
import { clusterColor, EXPRESSION_RAMP, VIRIDIS_RAMP, sampleRamp, type RGB } from "../lib/colors";
import { DIMMED_OPACITY } from "../lib/constants";
import { ScatterPanel } from "./ScatterPanel";
import { ClusterLegend } from "./ClusterLegend";
import { ColorBar } from "./ColorBar";
import "../styles/scatter.css";

const FULL_ALPHA = 255;
const DIMMED_ALPHA = Math.round(255 * DIMMED_OPACITY);

export function ScatterView() {
  const { data, loading, error } = useDatasetStore();
  const { colorMode, genes, ramp, highlighted, setHighlight } = useViewStore();

  // clusterId -> label, so the alpha-dimming check (which is label-based,
  // per ViewState.highlighted) can be done per point without a linear scan.
  const labelById = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of data?.clusters ?? []) map.set(c.id, c.label);
    return map;
  }, [data?.clusters]);

  const isDimmed = useMemo(() => {
    if (!highlighted) return () => false;
    const set = new Set(highlighted);
    return (clusterId: number) => !set.has(labelById.get(clusterId) ?? "");
  }, [highlighted, labelById]);

  if (loading) {
    return <div className="scatter-status">Loading dataset…</div>;
  }
  if (error || !data) {
    return <div className="scatter-status scatter-status-error">{error ?? "No data"}</div>;
  }

  const activeRamp: RGB[] = ramp === "viridis" ? VIRIDIS_RAMP : EXPRESSION_RAMP;

  if (colorMode === "cluster" || genes.length === 0) {
    const getColor = (i: number): [number, number, number, number] => {
      const clusterId = data.clusterIds[i];
      const [r, g, b] = clusterColor(clusterId);
      const a = isDimmed(clusterId) ? DIMMED_ALPHA : FULL_ALPHA;
      return [r, g, b, a];
    };

    return (
      <div className="scatter-view scatter-view-cluster">
        <div className="scatter-main">
          <ScatterPanel
            coords={data.coords}
            getColor={getColor}
            panelKey="cluster"
            updateKey={highlighted}
          />
          {/* Overlaid on the plot, not beside it — a legend column costs the
              scatter ~220px of width permanently. */}
          <ClusterLegend
            clusters={data.clusters}
            highlighted={highlighted}
            setHighlight={setHighlight}
          />
        </div>
      </div>
    );
  }

  // Expression mode: one panel + one independently-scaled colorbar per gene.
  const gridClass = genes.length > 1 ? "scatter-grid scatter-grid-multi" : "scatter-grid";

  return (
    <div className="scatter-view scatter-view-expression">
      <div className={gridClass}>
        {genes.map((gv) => {
          const getColor = (i: number): [number, number, number, number] => {
            const clusterId = data.clusterIds[i];
            const t = gv.values[i] / gv.max;
            const [r, g, b] = sampleRamp(activeRamp, t);
            const a = isDimmed(clusterId) ? DIMMED_ALPHA : FULL_ALPHA;
            return [r, g, b, a];
          };

          return (
            <div className="scatter-panel-wrap" key={gv.gene}>
              <div className="scatter-panel-title">{gv.gene}</div>
              <div className="scatter-panel-canvas">
                <ScatterPanel
                  coords={data.coords}
                  getColor={getColor}
                  panelKey={gv.gene}
                  updateKey={[ramp, highlighted, gv.gene]}
                />
              </div>
              <ColorBar gene={gv.gene} ramp={activeRamp} min={gv.min} max={gv.max} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
