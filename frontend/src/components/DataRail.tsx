/**
 * The data rail: gene search on top, marker table below. **Both always
 * visible** — never tabbed, never collapsed by default.
 *
 * This app exists to let you watch an LLM operate the UI. A tab that hides
 * the marker table also hides the agent's work: it calls `run_deg`, the table
 * fills, and you see nothing because you were on another tab. So both panels
 * stay on screen, and each flashes briefly when its contents change — whether
 * the change came from the agent or from you typing.
 *
 * Header counts are live for the same reason: "100 markers" appearing next to
 * a heading is a second, quieter signal that something just happened.
 */
import { useViewStore } from "../state/useViewStore";
import { useFlashOnChange } from "../hooks/useFlashOnChange";
import { GenePanel } from "./GenePanel";
import { DegPanel } from "./DegPanel";

export function DataRail() {
  const { genes, lastDeg } = useViewStore();

  // Flash keys describe *content*, not identity — re-running DEG on the same
  // group with the same result should not flash, but a new group should.
  const genesFlash = useFlashOnChange(genes.map((g) => g.gene).join(",") || "∅");
  const degFlash = useFlashOnChange(
    lastDeg ? `${lastDeg.group}:${lastDeg.markers.length}` : "∅"
  );

  return (
    <div className="data-rail">
      <section className={`data-section${genesFlash ? " is-flashing" : ""}`}>
        <header className="data-section-head">
          <h2>Genes</h2>
          {genes.length > 0 && (
            <span className="data-section-count">
              {genes.length} shown
            </span>
          )}
        </header>
        <GenePanel />
      </section>

      <section
        className={`data-section data-section-grow${degFlash ? " is-flashing" : ""}`}
      >
        <header className="data-section-head">
          <h2>Marker genes</h2>
          {lastDeg && (
            <span className="data-section-count">
              {lastDeg.markers.length} for {lastDeg.group}
            </span>
          )}
        </header>
        <DegPanel />
      </section>
    </div>
  );
}
