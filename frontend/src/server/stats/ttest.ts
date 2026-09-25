export function overestimScore(
  meanIn: number, varIn: number, meanOut: number, varOut: number, nIn: number,
): number {
  // ⚠️ n_g in BOTH denominators — scanpy's "hack for overestimating the
  //    variance for small groups" (ttest_ind_from_stats with nobs2 = ns_group)
  const denom = Math.sqrt(varIn / nIn + varOut / nIn);
  if (!(denom > 0)) return 0;
  return (meanIn - meanOut) / denom;
}

export function welchDf(varIn: number, varOut: number, nIn: number): number {
  // Welch–Satterthwaite with n1 = n2 = nIn reduces to:
  const num = (varIn + varOut) ** 2;
  const den = varIn * varIn + varOut * varOut;
  if (!(den > 0)) return 1;
  const df = ((nIn - 1) * num) / den;
  return Number.isFinite(df) && df > 0 ? df : 1;
}

export function log2FoldChange(meanIn: number, meanOut: number): number {
  return Math.log2((Math.expm1(meanIn) + 1e-9) / (Math.expm1(meanOut) + 1e-9));
}

function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
             -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300, EPS = 3e-16;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log1p(-x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (bt * betacf(a, b, x)) / a
    : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

export function tTwoSidedP(t: number, df: number): number {
  // Distinguish Infinity (maximally significant, p→0) from NaN (no information, p=1)
  if (Number.isFinite(t) === false && Number.isNaN(t)) return 1; // t is NaN
  if (!Number.isFinite(df) || df <= 0) return 1;
  if (Number.isFinite(t) === false) return 0; // t is ±Infinity, maximally significant
  const x = df / (df + t * t);
  return betai(df / 2, 0.5, x);
}
