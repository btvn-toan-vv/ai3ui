/**
 * The four HTTP endpoints that serve dataset metadata, gene search, gene
 * expression vectors, and differential expression results.
 *
 * Handlers stay thin: validate the request, call into `data/store.ts` or
 * `stats/deg.ts`, serialize the result. No business logic lives here.
 */

import express, { type Router } from "express";
import { loadDataset } from "../data/load";
import { geneColumn, clusterMask, findGenes, resolveClusterLabel } from "../data/store";
import { rankGenesGroups } from "../stats/deg";
import type {
  DatasetResponse,
  GeneVector,
  DegResponse,
  QueryGenesResponse,
  GeneSearchResponse,
} from "../../lib/types";

export const dataRouter: Router = express.Router();

/**
 * GET /api/data — everything the browser needs for the default view
 * (~60 KB). Deliberately omits `genes` — see DatasetResponse.
 */
dataRouter.get("/data", (_req, res) => {
  const d = loadDataset();
  const { genes: _genes, ...rest } = d.meta;
  const body: DatasetResponse = rest;
  res.json(body);
});

/**
 * GET /api/genes?q=&limit= — gene symbol search. Never returns the full
 * 13,714-symbol catalog; always respects `limit`.
 */
dataRouter.get("/genes", (req, res) => {
  const d = loadDataset();
  const q = String(req.query.q ?? "");
  const limitRaw = Number(req.query.limit ?? 50);
  const limit = Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50);
  const body: GeneSearchResponse = findGenes(d, q, limit);
  res.json(body);
});

/**
 * POST /api/query_genes — gene expression vectors, up to 4 genes at a time.
 * Unknown symbols are reported in `notFound` rather than causing a 400 — a
 * partial success the LLM can act on beats a 400 it can only apologise for.
 * Only an empty/absent `genes` array is a 400.
 */
dataRouter.post("/query_genes", (req, res) => {
  const d = loadDataset();
  const requested: unknown = req.body?.genes;

  if (!Array.isArray(requested) || requested.length === 0 || !requested.every((g) => typeof g === "string")) {
    return res.status(400).json({ error: "genes[] (non-empty array of strings) is required" });
  }

  const results: GeneVector[] = [];
  const notFound: string[] = [];

  for (const g of requested.slice(0, 4)) {
    const col = geneColumn(d, g);
    if (!col) {
      notFound.push(g);
      continue;
    }
    const idx = d.geneIndex.get(g.trim().toUpperCase())!;
    results.push({
      gene: d.meta.genes[idx],
      values: Array.from(col.values),
      min: col.min,
      max: col.max,
      pctExpressing: col.pctExpressing,
    });
  }

  const body: QueryGenesResponse = { results, notFound };
  res.json(body);
});

/**
 * POST /api/run_deg — differential expression for one cluster vs the rest.
 * On an unresolved/ambiguous label, the error message lists the valid
 * labels so the calling LLM can self-correct next round.
 */
dataRouter.post("/run_deg", (req, res) => {
  const d = loadDataset();

  const groupRaw = req.body?.group;
  if (typeof groupRaw !== "string" || groupRaw.trim() === "") {
    return res.status(400).json({ error: "group (string) is required" });
  }

  const topNRaw = Number(req.body?.topN ?? 100);
  const topN = Math.min(200, Number.isFinite(topNRaw) && topNRaw > 0 ? topNRaw : 100);

  const label = resolveClusterLabel(d, groupRaw);
  if (!label) {
    const validLabels = d.meta.clusters.map((c) => c.label).join(", ");
    return res.status(400).json({
      error: `Unknown or ambiguous group "${groupRaw}". Valid labels: ${validLabels}`,
    });
  }

  const cm = clusterMask(d, label);
  if (!cm) {
    // Should be unreachable given resolveClusterLabel already succeeded.
    const validLabels = d.meta.clusters.map((c) => c.label).join(", ");
    return res.status(400).json({
      error: `Unknown or ambiguous group "${groupRaw}". Valid labels: ${validLabels}`,
    });
  }

  const { mask, nIn } = cm;
  const t0 = performance.now();
  const markers = rankGenesGroups(d.matrix, d.meta.genes, mask, nIn, topN);
  console.log(`[deg] ${label}: ${d.meta.nGenes} genes in ${(performance.now() - t0).toFixed(0)} ms`);

  const body: DegResponse = {
    group: label,
    reference: "rest",
    nCellsGroup: nIn,
    nCellsReference: d.meta.nCells - nIn,
    markers,
    warning: nIn < 30 ? `${label} has only ${nIn} cells; results are noisy.` : null,
  };
  res.json(body);
});
