// Task 2: Data preparation script.
//
// Downloads the PBMC 3k `.h5ad` (legacy AnnData layout, no encoding-type
// attributes), reads it with h5wasm, transposes the raw expression matrix
// from CSR to CSC, and writes four artifacts into `data/`:
//   - data/pbmc3k.h5ad             (cached download, not committed)
//   - data/pbmc3k.X.data.f32       (CSC nonzero values, Float32Array)
//   - data/pbmc3k.X.indices.i32    (CSC row indices, Int32Array)
//   - data/pbmc3k.X.indptr.i32     (CSC column pointer, Int32Array)
//   - data/pbmc3k.meta.json        (genes, clusters, normalized UMAP coords)
//   - data/pbmc3k.oracle.json      (rank_genes_groups DEG fixture for tests)
//
// Everything downstream (stats module, server, UI) reads what this script
// writes, so correctness here is load-bearing. Re-running must be
// idempotent: skip the download if the .h5ad is already present, and
// produce byte-identical outputs on every run.

import * as fs from "node:fs";
import * as hdf5 from "h5wasm/node";
import { transposeCsrToCsc } from "../src/server/stats/sparse.js";

const URL =
  "https://raw.githubusercontent.com/chanzuckerberg/cellxgene/main/example-dataset/pbmc3k.h5ad";
const H5 = "data/pbmc3k.h5ad";

// ---- Step 1: Download the h5ad if absent ----------------------------------

if (!fs.existsSync(H5)) {
  fs.mkdirSync("data", { recursive: true });
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  fs.writeFileSync(H5, Buffer.from(await res.arrayBuffer()));
}
console.log(`h5ad: ${(fs.statSync(H5).size / 1e6).toFixed(1)} MB`);

// ---- Step 2: Open with h5wasm and read compound field order ---------------
//
// This is the legacy AnnData layout — no `encoding-type` attributes. Field
// positions inside compound datasets (obs, obsm, raw.var, ...) are read from
// each dataset's own metadata, never hardcoded, since the physical column
// order is an implementation detail of how the file was written.

await hdf5.ready;
const f = new hdf5.File(H5, "r");

function fieldIndex(path: string, name: string): number {
  const members = (f.get(path) as any).metadata.compound_type.members;
  const i = members.findIndex((m: any) => m.name === name);
  if (i < 0) {
    throw new Error(
      `field ${name} not found in ${path}; have: ${members.map((m: any) => m.name).join(",")}`,
    );
  }
  return i;
}

// ---- Step 3: Read cluster labels, codes, and UMAP --------------------------

const obs = (f.get("obs") as any).value as any[][]; // array of positional tuples
const louvainIdx = fieldIndex("obs", "louvain");
const clusterIds = obs.map((r) => Number(r[louvainIdx])); // int64 -> BigInt -> Number
const clusterLabels = (f.get("uns/louvain_categories") as any).value as string[];

const obsm = (f.get("obsm") as any).value as any[][];
const umapIdx = fieldIndex("obsm", "X_umap");
const rawUmap = obsm.map(
  (r) => [Number(r[umapIdx][0]), Number(r[umapIdx][1])] as [number, number],
);

// ---- Step 4: Normalize UMAP coordinates ------------------------------------
//
// Centre on the centroid and scale the larger extent to +/-10, so the DeckGL
// view needs no magic numbers. Do NOT negate Y here — Task 11 passes
// `flipY: false` instead; only one of the two should ever flip the axis.

const cx = rawUmap.reduce((s, p) => s + p[0], 0) / rawUmap.length;
const cy = rawUmap.reduce((s, p) => s + p[1], 0) / rawUmap.length;
const half = Math.max(
  ...rawUmap.map((p) => Math.max(Math.abs(p[0] - cx), Math.abs(p[1] - cy))),
);
const scale = 10 / half;
const coords = rawUmap.map((p) => [(p[0] - cx) * scale, (p[1] - cy) * scale] as [number, number]);

const xs = coords.map((p) => p[0]);
const ys = coords.map((p) => p[1]);
const bounds = {
  xMin: Math.min(...xs),
  xMax: Math.max(...xs),
  yMin: Math.min(...ys),
  yMax: Math.max(...ys),
};

// ---- Step 5: Read gene symbols and the raw CSR matrix ----------------------

const rawVar = (f.get("raw.var") as any).value as any[][];
const geneIdx = fieldIndex("raw.var", "index");
const genes = rawVar.map((r) => String(r[geneIdx]));

const data = (f.get("raw.X/data") as any).value as Float32Array;
const indices = (f.get("raw.X/indices") as any).value as Int32Array;
const indptr = (f.get("raw.X/indptr") as any).value; // may be BigInt64Array
const shape = (f.get("raw.X") as any).attrs.h5sparse_shape.value; // [2638, 13714]
const nCells = Number(shape[0]);
const nGenes = Number(shape[1]);
const rowPtr = Int32Array.from(Array.from(indptr as any, (v: any) => Number(v)));

console.log(
  `raw.X: nCells=${nCells} nGenes=${nGenes} data.length=${data.length} (expected nCells=2638 nGenes=13714 data.length=2238732)`,
);

// ---- Step 6: Transpose CSR -> CSC ------------------------------------------
//
// Every query in this app is gene-major (query_genes wants one gene's
// column; DEG iterates gene by gene). With CSC both are a contiguous slice.
// Do it once, offline, with a counting sort — O(nnz).

const csc = transposeCsrToCsc(data, indices, rowPtr, nCells, nGenes);
const cscData = csc.data;
const cscRows = csc.rows;
const colPtr = csc.colPtr;

// ---- Step 7: Extract the DEG oracle fixture --------------------------------
//
// The golden test (Task 6) must read real numbers, not hand-copied ones.

const rg = "uns/rank_genes_groups";
const namesRows = (f.get(`${rg}/names`) as any).value as any[][];
const scoresRows = (f.get(`${rg}/scores`) as any).value as any[][];
const nGroups = clusterLabels.length;
const oracle = {
  names: Array.from({ length: nGroups }, (_, g) => namesRows.map((r) => String(r[g]))),
  scores: Array.from({ length: nGroups }, (_, g) => scoresRows.map((r) => Number(r[g]))),
};

// ---- Step 8: Write all outputs and print the loud summary ------------------

const clusterCounts = new Array(clusterLabels.length).fill(0);
for (const id of clusterIds) clusterCounts[id]++;
const clusters = clusterLabels.map((label, id) => ({
  id,
  label,
  nCells: clusterCounts[id],
}));

const meta = {
  dataset: "pbmc3k",
  nCells,
  nGenes,
  genes,
  clusters,
  clusterIds,
  coords,
  bounds,
};

fs.writeFileSync("data/pbmc3k.X.data.f32", Buffer.from(cscData.buffer));
fs.writeFileSync("data/pbmc3k.X.indices.i32", Buffer.from(cscRows.buffer));
fs.writeFileSync("data/pbmc3k.X.indptr.i32", Buffer.from(colPtr.buffer));
fs.writeFileSync("data/pbmc3k.meta.json", JSON.stringify(meta));
fs.writeFileSync("data/pbmc3k.oracle.json", JSON.stringify(oracle));

const outputs = [
  "data/pbmc3k.X.data.f32",
  "data/pbmc3k.X.indices.i32",
  "data/pbmc3k.X.indptr.i32",
  "data/pbmc3k.meta.json",
  "data/pbmc3k.oracle.json",
];

console.log(`cells ${nCells}  genes ${nGenes}  nnz ${cscData.length}`);
for (const c of meta.clusters) console.log(`  ${c.id}  ${c.label.padEnd(20)} ${c.nCells}`);
for (const p of outputs) console.log(`  ${p}  ${(fs.statSync(p).size / 1e6).toFixed(2)} MB`);

f.close();
