import { describe, expect, it } from "vitest";
import { applyStutter, wordStarts } from "./stutter.ts";
import { charToViseme, poseAt, VISEME_POSES, type TimedChar } from "./visemes.ts";

describe("visemes", () => {
  it("maps letters to mouth shapes", () => {
    expect(charToViseme("A")).toBe("AA");
    expect(charToViseme("o")).toBe("OH");
    expect(charToViseme("m")).toBe("MBP");
    expect(charToViseme("t")).toBe("CONS");
    expect(charToViseme(" ")).toBe("rest");
    expect(charToViseme(",")).toBe("rest");
  });

  it("finds the pose at a time and rests in gaps", () => {
    const timeline: TimedChar[] = [
      { char: "m", start: 0, end: 0.1 },
      { char: "a", start: 0.1, end: 0.2 },
      { char: "o", start: 0.5, end: 0.6 },
    ];
    expect(poseAt(timeline, 0.05)).toEqual(VISEME_POSES.MBP);
    expect(poseAt(timeline, 0.15)).toEqual(VISEME_POSES.AA);
    expect(poseAt(timeline, 0.3)).toEqual(VISEME_POSES.rest);
    expect(poseAt(timeline, 0.55)).toEqual(VISEME_POSES.OH);
    expect(poseAt(timeline, 1)).toEqual(VISEME_POSES.rest);
    expect(poseAt([], 0)).toEqual(VISEME_POSES.rest);
  });
});

describe("stutter", () => {
  it("finds word starts", () => {
    expect(wordStarts([..."hi, it's ok"])).toEqual([0, 4, 9]);
  });

  it("repeats a slice and moves later characters", () => {
    const rate = 10; // 10 samples per second keeps the numbers small.
    const samples = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const timed: TimedChar[] = [
      { char: "a", start: 0.2, end: 0.4 },
      { char: "b", start: 0.6, end: 0.8 },
    ];
    const result = applyStutter(samples, rate, timed, [{ at: 0.2, slice: 0.2, repeats: 2 }]);
    expect(Array.from(result.samples)).toEqual([0, 1, 2, 3, 2, 3, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.events).toEqual([{ time: 0.2, duration: 0.4, at: 0.2, slice: 0.2 }]);
    const starts = result.timed.map((c) => [c.char, Number(c.start.toFixed(3))]);
    expect(starts).toEqual([
      ["a", 0.2],
      ["a", 0.4],
      ["a", 0.6],
      ["b", 1.0],
    ]);
  });

  it("returns the input unchanged with no picks", () => {
    const samples = Float32Array.from([1, 2, 3]);
    const timed: TimedChar[] = [{ char: "x", start: 0, end: 0.1 }];
    const result = applyStutter(samples, 10, timed, []);
    expect(Array.from(result.samples)).toEqual([1, 2, 3]);
    expect(result.timed).toEqual(timed);
    expect(result.events).toEqual([]);
  });
});
