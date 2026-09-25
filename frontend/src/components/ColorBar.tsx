/**
 * Expression mode colorbar: gradient + the gene's REAL numeric min/max.
 *
 * Each small-multiple panel gets its own ColorBar scaled to that gene's own
 * observed max — never a shared scale across genes with different dynamic
 * ranges, and never a silently clipped range.
 */
import type { RGB } from "../lib/colors";

export interface ColorBarProps {
  gene: string;
  ramp: RGB[];
  min: number;
  max: number;
}

export function ColorBar({ gene, ramp, min, max }: ColorBarProps) {
  const gradient = `linear-gradient(to right, ${ramp
    .map((c, i) => `rgb(${c[0]}, ${c[1]}, ${c[2]}) ${(i / (ramp.length - 1)) * 100}%`)
    .join(", ")})`;

  return (
    <div className="colorbar" aria-label={`Expression scale for ${gene}`}>
      <div className="colorbar-gene">{gene}</div>
      <div className="colorbar-gradient" style={{ backgroundImage: gradient }} />
      <div className="colorbar-scale">
        <span>{min.toFixed(2)}</span>
        <span>{max.toFixed(2)}</span>
      </div>
    </div>
  );
}
