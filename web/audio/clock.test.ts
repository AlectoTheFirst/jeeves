import { describe, expect, it } from "vitest";
import { playbackStartOf, toSpeechTime, type Insert } from "./clock.ts";

const repeat = (at: number, slice: number, repeats: number): Insert => ({
  at,
  slice,
  total: slice * repeats,
  kind: "repeat",
});

describe("toSpeechTime", () => {
  it("is the same as playback time with no inserts", () => {
    expect(toSpeechTime([], 1.5)).toEqual({ t: 1.5, silent: false });
  });

  it("loops inside a repeat and shifts the time after it", () => {
    const inserts = [repeat(1, 0.1, 2)]; // Adds 0.2 s at speech time 1.0.
    expect(toSpeechTime(inserts, 0.5).t).toBeCloseTo(0.5);
    expect(toSpeechTime(inserts, 1.05).t).toBeCloseTo(1.05);
    expect(toSpeechTime(inserts, 1.15).t).toBeCloseTo(1.05);
    expect(toSpeechTime(inserts, 1.25).t).toBeCloseTo(1.05);
    expect(toSpeechTime(inserts, 1.5).t).toBeCloseTo(1.3);
  });

  it("is silent during a gap", () => {
    const inserts: Insert[] = [{ at: 2, total: 0.3, kind: "gap", slice: 0 }];
    expect(toSpeechTime(inserts, 2.1)).toEqual({ t: 2, silent: true });
    expect(toSpeechTime(inserts, 2.5).t).toBeCloseTo(2.2);
  });

  it("adds the shift of every earlier insert", () => {
    const inserts = [repeat(1, 0.1, 1), { at: 2, total: 0.5, kind: "gap", slice: 0 } as Insert];
    expect(playbackStartOf(inserts, 2)).toBeCloseTo(2.6);
    expect(toSpeechTime(inserts, 3).t).toBeCloseTo(2.4);
  });
});
