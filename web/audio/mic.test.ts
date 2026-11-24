import { describe, expect, it } from "vitest";
import { isDead, peakOf, SILENCE_PEAK, trimDeadStart } from "./mic.ts";

describe("peakOf", () => {
  it("finds the largest absolute sample", () => {
    expect(peakOf(new Float32Array([0.1, -0.5, 0.3]))).toBeCloseTo(0.5);
  });

  it("marks a dead mic as silent", () => {
    expect(peakOf(new Float32Array([0.001, -0.002])) < SILENCE_PEAK).toBe(true);
  });
});

describe("dead mic start", () => {
  it("knows exact zeros from quiet sound", () => {
    expect(isDead(new Float32Array(128))).toBe(true);
    expect(isDead(new Float32Array([0, 0, 0.0001]))).toBe(false);
  });

  it("removes the exact zeros at the start only", () => {
    expect([...trimDeadStart(new Float32Array([0, 0, 0.5, 0, 0.25]))]).toEqual([0.5, 0, 0.25]);
    expect(trimDeadStart(new Float32Array(4))).toHaveLength(0);
  });
});
