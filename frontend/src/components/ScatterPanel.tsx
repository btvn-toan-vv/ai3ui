/**
 * A single DeckGL scatter canvas. One instance per "small multiple" panel —
 * cluster mode uses exactly one, expression mode uses one per gene.
 *
 * Two traps, both verified against the real deck.gl 9.x API (see task brief):
 *
 * 1. `views` takes a single `View`, not `[View]`. Wrapping it in an array
 *    makes the view-state type resolve to a per-viewId record instead of a
 *    flat `{ target, zoom }`, and TS rejects the object below with TS2559.
 * 2. `OrthographicView` defaults `flipY` to `true` (+Y down), which mirrors
 *    this UMAP vertically relative to every published scanpy figure. The
 *    data-prep step (Task 2) deliberately left Y un-negated, so `flipY:
 *    false` here is the ONLY place orientation is corrected — never negate
 *    Y anywhere else, or the two corrections cancel out.
 *
 * @format
 */

import { useMemo } from "react";
import DeckGL from "@deck.gl/react";
import { OrthographicView } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";

export interface ScatterPanelProps {
  coords: readonly (readonly [number, number])[];
  /** Returns [r, g, b, a] for point i. Alpha carries the highlight dimming. */
  getColor: (i: number) => [number, number, number, number];
  /** Included in the layer id so multiple panels don't collide. */
  panelKey: string;
  /**
   * Anything that should force `getFillColor` to re-run (color mode, active
   * gene, ramp, highlighted set). Deck.gl only re-invokes accessors when an
   * updateTrigger value changes.
   */
  updateKey: unknown;
}

const INITIAL_VIEW_STATE = {
  target: [0, 0, 0] as [number, number, number],
  zoom: 4,
  minZoom: -2,
  maxZoom: 10,
};

export function ScatterPanel({
  coords,
  getColor,
  panelKey,
  updateKey,
}: ScatterPanelProps) {
  const layer = useMemo(
    () =>
      new ScatterplotLayer<number>({
        id: `scatter-${panelKey}`,
        data: Array.from({ length: coords.length }, (_, i) => i),
        getPosition: (i) => [coords[i][0], coords[i][1]],
        getFillColor: (i) => getColor(i),
        radiusUnits: "pixels",
        getRadius: 2,
        pickable: true,
        transitions: { getFillColor: 300 },
        updateTriggers: { getFillColor: [updateKey] },
      }),
    // ScatterplotLayer instances are cheap to recreate; deck.gl diffs by id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [coords, panelKey, updateKey],
  );

  return (
    <DeckGL
      views={new OrthographicView({ id: "ortho", flipY: false })}
      controller={true}
      initialViewState={INITIAL_VIEW_STATE}
      layers={[layer]}
      style={{ background: "black" }}
    />
  );
}
