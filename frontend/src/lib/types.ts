/**
 * DTOs shared by the Express server and the browser.
 *
 * This is the wire contract. The server serializes these; `src/lib/api.ts`
 * deserializes them. Keep it free of runtime code so both sides can import
 * it without pulling anything else in.
 */

export interface ClusterInfo {
  id: number;
  label: string;
  nCells: number;
}

export interface Bounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/** The full prep artifact. `genes` is server-side only — see DatasetResponse. */
export interface Meta {
  dataset: string;
  nCells: number;
  nGenes: number;
  genes: string[];
  clusters: ClusterInfo[];
  clusterIds: number[];
  coords: [number, number][];
  bounds: Bounds;
}

/**
 * What `GET /api/data` returns (~60 KB).
 *
 * Deliberately omits `genes`: shipping 13,714 symbols to the browser on load
 * is what `search_genes` exists to avoid.
 */
export type DatasetResponse = Omit<Meta, "genes">;

export interface Marker {
  gene: string;
  score: number;
  log2fc: number;
  pval: number;
  fdr: number;
  pctIn: number;
  pctOut: number;
}

export interface GeneVector {
  gene: string;
  values: number[];
  min: number;
  max: number;
  pctExpressing: number;
}

export interface DegResponse {
  group: string;
  reference: string;
  nCellsGroup: number;
  nCellsReference: number;
  markers: Marker[];
  /** Set when the group has fewer than 30 cells. The agent relays it verbatim. */
  warning: string | null;
}

export interface QueryGenesResponse {
  results: GeneVector[];
  /** Unknown symbols are reported, not 400'd — a partial success the LLM can act on. */
  notFound: string[];
}

export interface GeneSearchResult {
  symbol: string;
  nCellsExpressing: number;
}

export interface GeneSearchResponse {
  genes: GeneSearchResult[];
  total: number;
  truncated: boolean;
}
