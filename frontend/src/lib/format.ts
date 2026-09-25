/**
 * Human-formatting helpers for numbers that otherwise render as raw floats
 * (`0.9222030981`, `1.889e-216`-as-string) in the DEG table and gene chips.
 */

/** `1.889e-216` -> `"1.89e-216"`. Used for FDR, which spans hundreds of orders of magnitude. */
export function formatScientific(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return String(x);
  return x.toExponential(digits);
}

/** Fixed-point with a sensible default precision (log2FC, expression ranges). */
export function formatFixed(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return String(x);
  return x.toFixed(digits);
}

/** `0.9220...` -> `"92.2%"`. Used for pctIn/pctOut. */
export function formatPercent(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return String(x);
  return `${(x * 100).toFixed(digits)}%`;
}
