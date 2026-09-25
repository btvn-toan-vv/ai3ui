/**
 * Typed accessors over the in-memory dataset. Everything here is a pure
 * function of `Dataset` — no I/O, no caching (that's `load.ts`'s job).
 */

import type { CSC } from "../stats/sparse";
import type { Meta } from "../../lib/types";

export interface Dataset {
  meta: Meta;
  matrix: CSC;
  /** Uppercase gene symbol -> column index. Built once in `load.ts`. */
  geneIndex: Map<string, number>;
}

/**
 * Densifies one CSC column into a full-length `Float32Array` (implicit
 * zeros stay zero). Gene lookup is case-insensitive and whitespace-tolerant.
 * Returns `null` for an unknown symbol.
 */
export function geneColumn(
  d: Dataset,
  gene: string,
): { values: Float32Array; min: number; max: number; pctExpressing: number } | null {
  const j = d.geneIndex.get(gene.trim().toUpperCase());
  if (j === undefined) return null;

  const values = new Float32Array(d.meta.nCells); // implicit zeros
  let max = 0;
  let nz = 0;
  for (let k = d.matrix.colPtr[j]; k < d.matrix.colPtr[j + 1]; k++) {
    const v = d.matrix.data[k];
    values[d.matrix.rows[k]] = v;
    if (v > max) max = v;
    nz++;
  }
  return { values, min: 0, max, pctExpressing: nz / d.meta.nCells };
}

/**
 * Forgiving cluster-label resolver — the LLM will paraphrase. Normalizes by
 * trimming, lowercasing, and collapsing internal whitespace. Tries an exact
 * match first, then a unique substring match. Returns the canonical label,
 * or `null` if absent or ambiguous (deliberately: silently picking one of
 * several candidates would be worse than reporting failure).
 */
export function resolveClusterLabel(d: Dataset, input: string): string | null {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const target = norm(input);

  const exact = d.meta.clusters.find((c) => norm(c.label) === target);
  if (exact) return exact.label;

  const partial = d.meta.clusters.filter((c) => norm(c.label).includes(target));
  return partial.length === 1 ? partial[0].label : null;
}

/**
 * Resolves `label` forgivingly (see `resolveClusterLabel`) and returns a
 * boolean membership mask over all cells, or `null` if the label is unknown
 * or ambiguous.
 */
export function clusterMask(
  d: Dataset,
  label: string,
): { mask: Uint8Array; nIn: number; id: number } | null {
  const canonical = resolveClusterLabel(d, label);
  if (canonical === null) return null;
  const cluster = d.meta.clusters.find((c) => c.label === canonical);
  if (!cluster) return null;

  const mask = new Uint8Array(d.meta.nCells);
  let nIn = 0;
  for (let i = 0; i < d.meta.nCells; i++) {
    if (d.meta.clusterIds[i] === cluster.id) {
      mask[i] = 1;
      nIn++;
    }
  }
  return { mask, nIn, id: cluster.id };
}

/**
 * Case-insensitive gene search. Prefix matches rank before substring
 * matches. Always respects `limit` — never returns the full 13,714-symbol
 * catalog. `nCellsExpressing` is read straight off `colPtr` (O(1) per gene,
 * no densification).
 */
export function findGenes(
  d: Dataset,
  q: string,
  limit: number,
): { genes: { symbol: string; nCellsExpressing: number }[]; total: number; truncated: boolean } {
  const query = q.trim().toUpperCase();

  // Empty query returns no matches
  if (query === "") {
    return { genes: [], total: 0, truncated: false };
  }

  const prefixMatches: number[] = [];
  const substringMatches: number[] = [];

  for (let j = 0; j < d.meta.genes.length; j++) {
    const upper = d.meta.genes[j].toUpperCase();
    if (upper.startsWith(query)) prefixMatches.push(j);
    else if (upper.includes(query)) substringMatches.push(j);
  }

  const ordered = prefixMatches.concat(substringMatches);
  const total = ordered.length;

  // Clamp limit to non-negative integer; treat negative or NaN as 0
  const clampedLimit = limit >= 0 ? Math.floor(limit) : 0;
  const sliced = ordered.slice(0, clampedLimit);

  const genes = sliced.map((j) => ({
    symbol: d.meta.genes[j],
    nCellsExpressing: d.matrix.colPtr[j + 1] - d.matrix.colPtr[j],
  }));

  return { genes, total, truncated: total > sliced.length };
}
