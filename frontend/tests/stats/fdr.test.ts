import { describe, it, expect } from "vitest";
import { benjaminiHochberg } from "../../src/server/stats/fdr";

describe("benjaminiHochberg", () => {
  it("matches a hand-computed vector", () => {
    // p sorted: 0.01 0.02 0.03 0.04 0.05, n = 5
    //   raw q = p*n/rank = 0.05, 0.05, 0.05, 0.05, 0.05
    const q = benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05]);
    for (const v of q) expect(v).toBeCloseTo(0.05, 12);
  });

  it("enforces monotonicity from the largest p downward", () => {
    // p sorted: 0.001 0.5, n = 2 → raw q = 0.002, 0.5 → already monotone
    // p sorted: 0.04 0.05, n = 2 → raw q = 0.08, 0.05 → 0.08 must clamp DOWN to 0.05
    const q = benjaminiHochberg([0.04, 0.05]);
    expect(q[0]).toBeCloseTo(0.05, 12);
    expect(q[1]).toBeCloseTo(0.05, 12);
  });

  it("preserves input order and clamps at 1", () => {
    const q = benjaminiHochberg([0.9, 0.001, 0.8]);
    expect(q[1]).toBeLessThan(q[0]);        // smallest p keeps smallest q
    for (const v of q) expect(v).toBeLessThanOrEqual(1);
  });

  it("handles a single p-value", () => {
    expect(Array.from(benjaminiHochberg([0.3]))[0]).toBeCloseTo(0.3, 12);
  });

  it("clamps raw q values exceeding 1 — single high value", () => {
    const q = benjaminiHochberg([1.2]);
    expect(q[0]).toBeLessThanOrEqual(1.0);
  });

  it("clamps raw q values exceeding 1 — multiple high values", () => {
    const q = benjaminiHochberg([1.1, 1.2]);
    expect(q[0]).toBeLessThanOrEqual(1.0);
    expect(q[1]).toBeLessThanOrEqual(1.0);
  });

  it("clamps mixed valid and supraunit p-values", () => {
    const q = benjaminiHochberg([0.5, 1.5]);
    for (const v of q) expect(v).toBeLessThanOrEqual(1.0);
  });
});
