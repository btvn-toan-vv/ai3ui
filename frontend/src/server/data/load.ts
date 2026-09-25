/**
 * Boot-time dataset loader. Reads the four `data/` artifacts produced by
 * `npm run prep` exactly once, memoized in a module-level variable — the
 * ~18 MB sparse matrix lives here in server memory and never ships to the
 * browser (see `DatasetResponse` in `src/lib/types.ts`).
 */

import fs from "node:fs";
import type { Meta } from "../../lib/types";
import type { Dataset } from "./store";

let cached: Dataset | null = null;

type TypedArrayCtor<T> = { new (buffer: ArrayBufferLike, byteOffset: number, length: number): T; BYTES_PER_ELEMENT: number };

function readTyped<T>(path: string, ctor: TypedArrayCtor<T>): T {
  const buf = fs.readFileSync(path);
  return new ctor(buf.buffer, buf.byteOffset, buf.byteLength / ctor.BYTES_PER_ELEMENT);
}

/** Reads and memoizes the dataset. Safe to call repeatedly; only loads once. */
export function loadDataset(): Dataset {
  if (cached) return cached;

  const requiredFiles = [
    "data/pbmc3k.meta.json",
    "data/pbmc3k.X.data.f32",
    "data/pbmc3k.X.indices.i32",
    "data/pbmc3k.X.indptr.i32",
  ];

  const missing = requiredFiles.filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    throw new Error(`data/ is incomplete — missing: ${missing.join(", ")}. Run \`npm run prep\` first`);
  }

  const meta: Meta = JSON.parse(fs.readFileSync("data/pbmc3k.meta.json", "utf8"));

  const matrix = {
    data: readTyped("data/pbmc3k.X.data.f32", Float32Array),
    rows: readTyped("data/pbmc3k.X.indices.i32", Int32Array),
    colPtr: readTyped("data/pbmc3k.X.indptr.i32", Int32Array),
    nRows: meta.nCells,
    nCols: meta.nGenes,
  };

  const geneIndex = new Map<string, number>();
  meta.genes.forEach((g, i) => geneIndex.set(g.toUpperCase(), i));

  console.log(`[data] ${meta.nCells} cells x ${meta.nGenes} genes, nnz ${matrix.data.length}`);

  cached = { meta, matrix, geneIndex };
  return cached;
}
