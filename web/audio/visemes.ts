// Text characters to mouth poses. English only, from letters (not phonemes),
// which is good enough for a stylized head.
import type { MouthPose } from "../scene/head.ts";

export type Viseme = "rest" | "AA" | "EE" | "OH" | "OO" | "MBP" | "FV" | "CONS";

export const VISEME_POSES: Record<Viseme, MouthPose> = {
  rest: { jaw: 0, wide: 0, round: 0 },
  AA: { jaw: 0.75, wide: 0.2, round: 0 },
  EE: { jaw: 0.3, wide: 0.85, round: 0 },
  OH: { jaw: 0.55, wide: 0, round: 0.75 },
  OO: { jaw: 0.25, wide: 0, round: 1 },
  MBP: { jaw: 0, wide: 0.1, round: 0 },
  FV: { jaw: 0.12, wide: 0.35, round: 0 },
  CONS: { jaw: 0.22, wide: 0.3, round: 0 },
};

const MAP: Record<string, Viseme> = {
  a: "AA",
  e: "EE",
  i: "EE",
  y: "EE",
  o: "OH",
  u: "OO",
  w: "OO",
  q: "OO",
  m: "MBP",
  b: "MBP",
  p: "MBP",
  f: "FV",
  v: "FV",
};

export function charToViseme(char: string): Viseme {
  const c = char.toLowerCase();
  if (c in MAP) return MAP[c];
  if (/\p{L}|\p{N}/u.test(c)) return "CONS";
  return "rest";
}

/** 1 character with its play time, in seconds on any clock. */
export type TimedChar = { char: string; start: number; end: number };

/**
 * Mouth pose at time `t`. `timeline` must be sorted by start time.
 * Between characters and after the last one, the mouth rests.
 */
export function poseAt(timeline: readonly TimedChar[], t: number): MouthPose {
  let lo = 0;
  let hi = timeline.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0 || t > timeline[found].end) return VISEME_POSES.rest;
  return VISEME_POSES[charToViseme(timeline[found].char)];
}
