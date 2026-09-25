import { columnMeanVar, type CSC } from "./sparse";
import { benjaminiHochberg } from "./fdr";
import { overestimScore, welchDf, log2FoldChange, tTwoSidedP } from "./ttest";

export interface Marker {
  gene: string; score: number; log2fc: number;
  pval: number; fdr: number; pctIn: number; pctOut: number;
}

export function rankGenesGroups(
  m: CSC, genes: string[], mask: Uint8Array, nIn: number, topN: number,
): Marker[] {
  const nGenes = m.nCols;
  const nOut = m.nRows - nIn;

  const scores = new Float64Array(nGenes);
  const l2fc   = new Float64Array(nGenes);
  const pvals  = new Float64Array(nGenes);
  const pctIn  = new Float64Array(nGenes);
  const pctOut = new Float64Array(nGenes);

  for (let j = 0; j < nGenes; j++) {
    const s = columnMeanVar(m, j, mask, nIn);

    let sc = overestimScore(s.meanIn, s.varIn, s.meanOut, s.varOut, nIn);
    if (!Number.isFinite(sc)) sc = 0;              // scanpy: NaN scores → 0
    scores[j] = sc;

    l2fc[j] = log2FoldChange(s.meanIn, s.meanOut);

    const p = tTwoSidedP(sc, welchDf(s.varIn, s.varOut, nIn));
    pvals[j] = Number.isFinite(p) ? p : 1.0;       // scanpy: NaN p-values → 1.0

    pctIn[j]  = nIn  > 0 ? s.nzIn  / nIn  : 0;
    pctOut[j] = nOut > 0 ? s.nzOut / nOut : 0;
  }

  // ⚠️ BH across ALL genes, THEN slice. Never the reverse.
  const fdr = benjaminiHochberg(pvals);

  const order = Array.from({ length: nGenes }, (_, i) => i)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, Math.min(topN, nGenes));

  return order.map(j => ({
    gene: genes[j], score: scores[j], log2fc: l2fc[j],
    pval: pvals[j], fdr: fdr[j], pctIn: pctIn[j], pctOut: pctOut[j],
  }));
}
