export function benjaminiHochberg(pvals: Float64Array | number[]): Float64Array {
  const n = pvals.length;
  const out = new Float64Array(n);
  if (n === 0) return out;

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => pvals[a] - pvals[b]);

  // walk from the largest p down, carrying the running minimum
  let running = Infinity;
  for (let rank = n; rank >= 1; rank--) {
    const idx = order[rank - 1];
    const q = (pvals[idx] * n) / rank;
    running = Math.min(running, q);
    out[idx] = Math.min(1, running);
  }
  return out;
}
