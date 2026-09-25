/**
 * Palettes for the scatter plot, as `[r, g, b]` tuples (what DeckGL wants).
 *
 * These values were generated and validated upstream — do not substitute
 * other palettes. Measured worst-case pairwise ΔE across the 12 cluster
 * colours: 20.7 normal, 13.4 deuteranomaly, 8.8 protanomaly, 11.0
 * tritanomaly. (Tableau-10 scores 2.4 under protanomaly, which is why it is
 * not a safe default here.)
 */

export type RGB = [number, number, number];

/**
 * Okabe–Ito, with pure black swapped for brown so it does not read as
 * "missing data", extended by four colours chosen via greedy max-min search
 * in CAM02-UCS under normal + three CVD simulations.
 *
 * The dataset has 8 clusters, so there is headroom.
 */
export const CLUSTER_COLORS: RGB[] = [
  [0, 114, 178], // #0072B2  blue
  [230, 159, 0], // #E69F00  orange
  [0, 158, 115], // #009E73  green
  [213, 94, 0], // #D55E00  vermillion
  [204, 121, 167], // #CC79A7  pink
  [86, 180, 233], // #56B4E9  sky
  [240, 228, 66], // #F0E442  yellow
  [140, 109, 49], // #8C6D31  brown
  [135, 0, 75], // #87004B  magenta
  [90, 15, 195], // #5A0FC3  violet
  [75, 75, 0], // #4B4B00  olive
  [165, 195, 165], // #A5C3A5  sage
];

/**
 * Default expression ramp: grey → red. Zero-expression cells recede to light
 * grey and expressing cells pop. Strictly monotonic lightness (CAM02-UCS J
 * from 95 down to 24), so it survives greyscale printing and CVD.
 */
export const EXPRESSION_RAMP: RGB[] = [
  [237, 237, 237],
  [243, 214, 199],
  [245, 186, 160],
  [241, 151, 120],
  [231, 111, 85],
  [216, 71, 58],
  [188, 37, 47],
  [149, 15, 38],
  [103, 0, 31],
];

/** Alternate ramp, offered as a toggle for people who expect viridis. */
export const VIRIDIS_RAMP: RGB[] = [
  [68, 1, 84],
  [71, 45, 123],
  [59, 82, 139],
  [44, 114, 142],
  [33, 145, 140],
  [40, 174, 128],
  [94, 201, 98],
  [173, 220, 48],
  [253, 231, 37],
];

/**
 * Sample a ramp at `t` in [0, 1] with linear RGB interpolation between the
 * nine anchors. Measured max ΔE 1.0 against true 256-stop viridis —
 * perceptually identical, so no interpolation library is needed.
 *
 * Out-of-range and non-finite `t` clamp rather than throwing: callers divide
 * by a gene's observed max, which is 0 for an all-zero gene.
 */
export function sampleRamp(ramp: RGB[], t: number): RGB {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const x = clamped * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  const a = ramp[i];
  const b = ramp[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** Cluster id → colour. Cluster id 0 gets CLUSTER_COLORS[0], as specified. */
export const clusterColor = (i: number): RGB =>
  CLUSTER_COLORS[i % CLUSTER_COLORS.length];
