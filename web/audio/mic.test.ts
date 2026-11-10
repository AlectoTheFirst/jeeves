import { describe, expect, it } from "vitest";
import { peakOf, SILENCE_PEAK } from "./mic.ts";

describe("peakOf", () => {
  it("finds the largest absolute sample", () => {
    expect(peakOf(new Float32Array([0.1, -0.5, 0.3]))).toBeCloseTo(0.5);
  });

  it("marks a dead mic as silent", () => {
    expect(peakOf(new Float32Array([0.001, -0.002])) < SILENCE_PEAK).toBe(true);
  });
});
