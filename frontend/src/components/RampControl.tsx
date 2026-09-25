/**
 * Expression ramp toggle, shown as the ramp itself rather than its name.
 *
 * "Ramp: grey → red" made the user read a description of a colour scale and
 * translate it back into colours. A gradient swatch IS the colour scale —
 * nothing to decode, and switching to viridis is legible at a glance.
 *
 * The gradient is built from the same nine anchors the scatter samples
 * (`EXPRESSION_RAMP` / `VIRIDIS_RAMP`), so the control cannot drift out of
 * sync with what the plot actually draws.
 */
import { EXPRESSION_RAMP, VIRIDIS_RAMP, type RGB } from "../lib/colors";
import { useViewStore } from "../state/useViewStore";

/** Nine anchors → an evenly-stopped CSS gradient. Same stops the plot uses. */
function gradientOf(ramp: RGB[]): string {
  const stops = ramp
    .map((c, i) => `rgb(${c[0]},${c[1]},${c[2]}) ${(i / (ramp.length - 1)) * 100}%`)
    .join(", ");
  return `linear-gradient(90deg, ${stops})`;
}

const RAMPS = {
  expression: { label: "Grey → red", colors: EXPRESSION_RAMP },
  viridis: { label: "Viridis", colors: VIRIDIS_RAMP },
} as const;

export function RampControl() {
  const { ramp, setRamp } = useViewStore();
  const next = ramp === "expression" ? "viridis" : "expression";

  return (
    <button
      type="button"
      className="ramp-control"
      onClick={() => setRamp(next)}
      /* The swatch carries the meaning visually; screen readers need it in
         words, and sighted users need to know what clicking does. */
      aria-label={`Colour ramp: ${RAMPS[ramp].label}. Switch to ${RAMPS[next].label}.`}
      title={`Switch to ${RAMPS[next].label}`}
    >
      {/* Swatch only — the gradient IS the label. The name sat beside it
          restating in words what the colours already show, which is exactly
          the redundancy this control was built to remove. The name still
          reaches screen readers and hover via aria-label/title above. */}
      <span
        className="ramp-control-swatch"
        style={{ backgroundImage: gradientOf(RAMPS[ramp].colors) }}
        aria-hidden="true"
      />
    </button>
  );
}
