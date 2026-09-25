/**
 * The ONE fetch-then-store path for putting genes on screen: `queryGenes`
 * (network) followed by `useViewStore().showGenes` (store). Three callers
 * share this function — the manual gene-input box (`GenePanel`), a clicked
 * marker row (`DegPanel`), and, from Task 14 onward, the LLM's `query_genes`
 * tool. Do not re-implement this fetch-then-store sequence at any of those
 * call sites: if the manual path and the agent path ever diverge in how they
 * resolve/merge/cap genes, one of them is lying to the user about what's on
 * screen.
 *
 * Merge policy lives here too (not in the callers) for the same reason: it
 * dedupes against what's already displayed, refreshes stale vectors for
 * genes re-requested, and enforces the 4-gene cap by rejecting the whole
 * request with a visible error rather than silently dropping a gene.
 */
import { queryGenes } from "./api";
import { MAX_GENES } from "./constants";
import type { GeneVector } from "./types";

export interface GeneDisplayTarget {
  showGenes(g: GeneVector[]): void;
  setError(e: string | null): void;
}

/**
 * Merge `incoming` into `existing`, keeping existing order and updating any
 * gene that appears in both (e.g. a re-run with fresh data). Newly-added
 * genes are appended in the order they arrived.
 */
export function mergeGeneVectors(
  existing: GeneVector[],
  incoming: GeneVector[]
): GeneVector[] {
  const merged = existing.slice();
  for (const g of incoming) {
    const idx = merged.findIndex((e) => e.gene === g.gene);
    if (idx >= 0) merged[idx] = g;
    else merged.push(g);
  }
  return merged;
}

/**
 * Resolve `symbols` via `/api/query_genes` and merge the result into
 * `existing`, then call `showGenes` with the merged list. Any unknown
 * symbol, network failure, or would-be breach of the 4-gene cap surfaces
 * through `setError` instead of throwing — callers do not need their own
 * try/catch.
 */
export async function displayGenes(
  symbols: string[],
  existing: GeneVector[],
  target: GeneDisplayTarget,
  signal?: AbortSignal
): Promise<void> {
  const requested = symbols.map((s) => s.trim()).filter((s) => s.length > 0);
  if (requested.length === 0) return;

  // Fast path: if every displayed slot is full and none of the requested
  // symbols are already on screen, reject before making a network call —
  // the cap is a UI concern, not something that should depend on the
  // server being reachable.
  const existingUpper = new Set(existing.map((g) => g.gene.toUpperCase()));
  const allNew = requested.every((s) => !existingUpper.has(s.toUpperCase()));
  if (allNew && existing.length + requested.length > MAX_GENES) {
    target.setError(
      `Only ${MAX_GENES} genes can be shown at once — remove one before adding another.`
    );
    return;
  }

  let response;
  try {
    response = await queryGenes(requested, signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    target.setError(err instanceof Error ? err.message : String(err));
    return;
  }

  const { results, notFound } = response;

  if (results.length > 0) {
    const merged = mergeGeneVectors(existing, results);
    if (merged.length > MAX_GENES) {
      target.setError(
        `Only ${MAX_GENES} genes can be shown at once — remove one before adding another.`
      );
      return;
    }
    target.showGenes(merged);
  }

  if (notFound.length > 0) {
    target.setError(`Gene(s) not found: ${notFound.join(", ")}`);
  } else if (results.length > 0) {
    target.setError(null);
  }
}
