export interface CSC { data: Float32Array; rows: Int32Array; colPtr: Int32Array; nRows: number; nCols: number }
export interface MeanVar { meanIn: number; varIn: number; meanOut: number; varOut: number; nzIn: number; nzOut: number }

export function columnMeanVar(m: CSC, col: number, mask: Uint8Array, nIn: number): MeanVar {
  const nOut = m.nRows - nIn;
  let sIn = 0, qIn = 0, nzIn = 0, sOut = 0, qOut = 0, nzOut = 0;

  for (let k = m.colPtr[col]; k < m.colPtr[col + 1]; k++) {
    const v = m.data[k];
    if (mask[m.rows[k]]) { sIn += v; qIn += v * v; nzIn++; }
    else                 { sOut += v; qOut += v * v; nzOut++; }
  }

  const meanIn = nIn > 0 ? sIn / nIn : 0;
  const meanOut = nOut > 0 ? sOut / nOut : 0;
  // ddof = 1; guard n < 2 and clamp float noise at zero
  const varIn  = nIn  > 1 ? Math.max(0, (qIn  - nIn  * meanIn  * meanIn))  / (nIn  - 1) : 0;
  const varOut = nOut > 1 ? Math.max(0, (qOut - nOut * meanOut * meanOut)) / (nOut - 1) : 0;

  return { meanIn, varIn, meanOut, varOut, nzIn, nzOut };
}

export function transposeCsrToCsc(
  data: Float32Array, cols: Int32Array, rowPtr: Int32Array, nRows: number, nCols: number,
): CSC {
  const colPtr = new Int32Array(nCols + 1);
  for (let k = 0; k < cols.length; k++) colPtr[cols[k] + 1]++;
  for (let j = 0; j < nCols; j++) colPtr[j + 1] += colPtr[j];

  const cursor = Int32Array.from(colPtr.subarray(0, nCols));
  const outData = new Float32Array(data.length);
  const outRows = new Int32Array(data.length);
  for (let row = 0; row < nRows; row++) {
    for (let k = rowPtr[row]; k < rowPtr[row + 1]; k++) {
      const dst = cursor[cols[k]]++;
      outData[dst] = data[k];
      outRows[dst] = row;
    }
  }
  return { data: outData, rows: outRows, colPtr, nRows, nCols };
}
