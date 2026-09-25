import { describe, it, expect } from "vitest";
import { columnMeanVar, transposeCsrToCsc } from "../../src/server/stats/sparse";

// dense reference, ddof = 1
function denseMeanVar(xs: number[]) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, v };
}

describe("columnMeanVar", () => {
  it("matches a dense reference, counting implicit zeros toward n", () => {
    // 5 cells x 1 gene, values: [3, 0, 1, 0, 8]   (0s are implicit)
    const m = { data: new Float32Array([3, 1, 8]), rows: new Int32Array([0, 2, 4]),
                colPtr: new Int32Array([0, 3]), nRows: 5, nCols: 1 };
    const mask = new Uint8Array([1, 1, 1, 0, 0]);   // group = cells 0,1,2
    const r = columnMeanVar(m, 0, mask, 3);

    const inRef  = denseMeanVar([3, 0, 1]);
    const outRef = denseMeanVar([0, 8]);
    expect(r.meanIn).toBeCloseTo(inRef.mean, 10);
    expect(r.varIn).toBeCloseTo(inRef.v, 10);
    expect(r.meanOut).toBeCloseTo(outRef.mean, 10);
    expect(r.varOut).toBeCloseTo(outRef.v, 10);
    expect(r.nzIn).toBe(2);    // 3 and 1
    expect(r.nzOut).toBe(1);   // 8
  });

  it("returns zero variance for an all-zero column", () => {
    const m = { data: new Float32Array([]), rows: new Int32Array([]),
                colPtr: new Int32Array([0, 0]), nRows: 4, nCols: 1 };
    const r = columnMeanVar(m, 0, new Uint8Array([1, 1, 0, 0]), 2);
    expect(r.meanIn).toBe(0);
    expect(r.varIn).toBe(0);
  });
});

describe("transposeCsrToCsc", () => {
  it("round-trips a small fixture", () => {
    // dense 3x2:  [[1,0],[0,2],[3,4]]
    const csc = transposeCsrToCsc(
      new Float32Array([1, 2, 3, 4]), new Int32Array([0, 1, 0, 1]),
      new Int32Array([0, 1, 2, 4]), 3, 2);
    const dense = (col: number) => {
      const out = [0, 0, 0];
      for (let k = csc.colPtr[col]; k < csc.colPtr[col + 1]; k++) out[csc.rows[k]] = csc.data[k];
      return out;
    };
    expect(dense(0)).toEqual([1, 0, 3]);
    expect(dense(1)).toEqual([0, 2, 4]);
  });
});
