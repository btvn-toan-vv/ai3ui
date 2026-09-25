import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import { rankGenesGroups } from "../../src/server/stats/deg";
import type { CSC } from "../../src/server/stats/sparse";

let m: CSC, meta: any, oracle: { names: string[][]; scores: number[][] };

beforeAll(() => {
  if (!fs.existsSync("data/pbmc3k.meta.json")) {
    throw new Error("run `npm run prep` before the golden test");
  }
  meta = JSON.parse(fs.readFileSync("data/pbmc3k.meta.json", "utf8"));
  oracle = JSON.parse(fs.readFileSync("data/pbmc3k.oracle.json", "utf8"));
  const rd = (p: string, T: any) => {
    const b = fs.readFileSync(p);
    return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT);
  };
  m = {
    data:   rd("data/pbmc3k.X.data.f32", Float32Array),
    rows:   rd("data/pbmc3k.X.indices.i32", Int32Array),
    colPtr: rd("data/pbmc3k.X.indptr.i32", Int32Array),
    nRows: meta.nCells, nCols: meta.nGenes,
  };
});

describe("rankGenesGroups — golden vs scanpy", () => {
  it("reproduces top-100 names in order and scores within 1e-2 for all 8 groups", () => {
    let worst = 0;
    for (let g = 0; g < meta.clusters.length; g++) {
      const mask = new Uint8Array(meta.nCells);
      let nIn = 0;
      for (let i = 0; i < meta.nCells; i++) {
        if (meta.clusterIds[i] === g) { mask[i] = 1; nIn++; }
      }
      const got = rankGenesGroups(m, meta.genes, mask, nIn, 100);

      expect(got.map(x => x.gene), `group ${g} ${meta.clusters[g].label}`)
        .toEqual(oracle.names[g]);

      for (let i = 0; i < 100; i++) {
        const d = Math.abs(got[i].score - oracle.scores[g][i]);
        worst = Math.max(worst, d);
        expect(d, `group ${g} rank ${i} gene ${got[i].gene}`).toBeLessThan(1e-2);
      }
    }
    // The oracle is stored as float32 and scanpy accumulates in a different
    // order — 1.45e-3 is the best achievable. Do NOT tighten to 1e-3.
    console.log(`golden: max |Δscore| = ${worst.toExponential(3)}`);
    expect(worst).toBeLessThan(1e-2);
  }, 120_000);

  it("reproduces the published CD4 T cells top marker figures", () => {
    const g = 0;
    const mask = new Uint8Array(meta.nCells);
    let nIn = 0;
    for (let i = 0; i < meta.nCells; i++) {
      if (meta.clusterIds[i] === g) { mask[i] = 1; nIn++; }
    }
    expect(nIn).toBe(1144);
    const top = rankGenesGroups(m, meta.genes, mask, nIn, 10)[0];
    expect(top.gene).toBe("LDHB");
    expect(top.score).toBeCloseTo(35.554, 1);
    expect(top.log2fc).toBeCloseTo(2.195, 2);
    expect(top.pctIn).toBeCloseTo(0.922, 2);
    expect(top.pctOut).toBeCloseTo(0.486, 2);
    
    // BH correction for rank 1: fdr ≈ pval × nGenes / 1
    // Check this relationship discriminates BH-before-slice from BH-after.
    const expectedRatio = top.pval * meta.nGenes;
    const ratio = top.fdr / expectedRatio;
    expect(ratio).toBeCloseTo(1, 0);  // within 50% tolerance (0 decimal places)
    
    // Also verify FDR is still an extremely small number (sanity check).
    expect(top.fdr).toBeLessThan(1e-200);
  }, 60_000);
});
