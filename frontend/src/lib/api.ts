/**
 * Typed fetch wrappers — the one place that knows the server's URL shapes.
 *
 * Every function takes an optional `AbortSignal` so the chat UI can cancel
 * an in-flight request (e.g. "stop generating" during a DEG run). On a
 * non-OK response we read the JSON body and throw an `Error` carrying the
 * server's `error` field verbatim — for `run_deg` in particular, that field
 * contains the valid cluster labels so the LLM can self-correct on retry.
 * Swallowing it into a generic "request failed" would throw that away.
 */

import type {
  DatasetResponse,
  DegResponse,
  GeneSearchResponse,
  QueryGenesResponse,
} from "./types";
import { DEFAULT_DEG_TOP_N, DEFAULT_GENE_SEARCH_LIMIT } from "./constants";

async function readErrorMessage(res: Response, url: string): Promise<string> {
  const detail = await res.json().catch(() => ({}) as { error?: unknown });
  const message = (detail as { error?: unknown }).error;
  return typeof message === "string" && message.length > 0
    ? message
    : `${url} failed: ${res.status}`;
}

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: "GET", signal });
  if (!res.ok) throw new Error(await readErrorMessage(res, url));
  return res.json() as Promise<T>;
}

async function post<T>(
  url: string,
  body: unknown,
  signal?: AbortSignal
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await readErrorMessage(res, url));
  return res.json() as Promise<T>;
}

/** `GET /api/data` — the ~60 KB view payload (clusters, coords, bounds). */
export function fetchDataset(signal?: AbortSignal): Promise<DatasetResponse> {
  return get<DatasetResponse>("/api/data", signal);
}

/** `GET /api/genes?q=&limit=` — never fetches the full 13,714-symbol list. */
export function searchGenes(
  q: string,
  signal?: AbortSignal
): Promise<GeneSearchResponse> {
  const params = new URLSearchParams({
    q,
    limit: String(DEFAULT_GENE_SEARCH_LIMIT),
  });
  return get<GeneSearchResponse>(`/api/genes?${params}`, signal);
}

/** `POST /api/query_genes` — up to 4 symbols; unknowns come back in `notFound`. */
export function queryGenes(
  genes: string[],
  signal?: AbortSignal
): Promise<QueryGenesResponse> {
  return post<QueryGenesResponse>("/api/query_genes", { genes }, signal);
}

/** `POST /api/run_deg` — marker genes for `group` vs. the rest. */
export function runDeg(
  group: string,
  topN: number = DEFAULT_DEG_TOP_N,
  signal?: AbortSignal
): Promise<DegResponse> {
  return post<DegResponse>("/api/run_deg", { group, topN }, signal);
}
