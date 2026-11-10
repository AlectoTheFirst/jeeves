// The "stutter" glitch: repeat the first part of a word, as a broken video tape does.
// Pure functions on samples and character times, so they are easy to test.
import type { TimedChar } from "./visemes.ts";

export type StutterPick = {
  /** Start of the slice to repeat, in seconds from the start of the samples. */
  at: number;
  /** Length of the slice in seconds. */
  slice: number;
  /** How many extra times the slice plays. */
  repeats: number;
};

export type StutterResult = {
  samples: Float32Array<ArrayBuffer>;
  timed: TimedChar[];
  /** Each repeat block that was applied. Overlapping picks are skipped. */
  events: StutterEvent[];
};

export type StutterEvent = {
  /** Start of the repeat block in seconds on the output clock. */
  time: number;
  /** Total added length in seconds (slice × repeats). */
  duration: number;
  /** Start of the repeated slice in seconds on the input clock. */
  at: number;
  /** Length of 1 slice in seconds. */
  slice: number;
};

/** Indexes of characters that start a word: a letter after a space, punctuation or the start. */
export function wordStarts(chars: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const isLetter = /\p{L}/u.test(chars[i]);
    const prevIsLetter = i > 0 && /\p{L}|\p{N}|'/u.test(chars[i - 1]);
    if (isLetter && !prevIsLetter) out.push(i);
  }
  return out;
}

export function applyStutter(
  samples: Float32Array,
  sampleRate: number,
  timed: readonly TimedChar[],
  picks: readonly StutterPick[],
): StutterResult {
  const sorted = [...picks]
    .filter((p) => p.repeats > 0 && p.slice > 0)
    .sort((a, b) => a.at - b.at);
  const blocks = sorted.map((p) => {
    const from = Math.max(0, Math.min(samples.length, Math.round(p.at * sampleRate)));
    const to = Math.max(from, Math.min(samples.length, from + Math.round(p.slice * sampleRate)));
    return { from, to, repeats: p.repeats };
  });
  const extra = blocks.reduce((n, b) => n + (b.to - b.from) * b.repeats, 0);
  const out = new Float32Array(samples.length + extra);
  const outTimed: TimedChar[] = [];
  const events: StutterResult["events"] = [];

  let read = 0; // Next input sample to copy.
  let write = 0; // Next output sample.
  let shift = 0; // Seconds added so far.
  let charIndex = 0;
  const copyCharsBefore = (limitSec: number) => {
    while (charIndex < timed.length && timed[charIndex].start < limitSec) {
      const c = timed[charIndex++];
      outTimed.push({ char: c.char, start: c.start + shift, end: c.end + shift });
    }
  };

  for (const b of blocks) {
    if (b.from < read) continue; // Overlaps the block before. Skip it.
    out.set(samples.subarray(read, b.from), write);
    write += b.from - read;
    read = b.from;
    copyCharsBefore(b.from / sampleRate);

    const len = b.to - b.from;
    const sliceSec = len / sampleRate;
    if (len === 0) continue;
    events.push({ time: write / sampleRate, duration: sliceSec * b.repeats, at: b.from / sampleRate, slice: sliceSec });
    // Characters in the slice repeat too, so the mouth repeats with the sound.
    const inSlice = timed.filter((c) => c.start >= b.from / sampleRate && c.start < b.to / sampleRate);
    for (let r = 0; r < b.repeats; r++) {
      out.set(samples.subarray(b.from, b.to), write);
      for (const c of inSlice) {
        outTimed.push({ char: c.char, start: c.start + shift, end: Math.min(c.end, b.to / sampleRate) + shift });
      }
      write += len;
      shift += sliceSec;
    }
  }
  out.set(samples.subarray(read), write);
  copyCharsBefore(Infinity);
  return { samples: out, timed: outTimed, events };
}
