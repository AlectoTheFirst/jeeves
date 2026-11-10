import { describe, expect, it } from "vitest";
import { level, resample, toBase64, toPcm16 } from "./pcm.ts";

describe("pcm", () => {
  it("resamples 48 kHz to 16 kHz with the correct length and values", () => {
    const input = Float32Array.from({ length: 48 }, (_, i) => i / 48);
    const out = resample(input, 48000, 16000);
    expect(out.length).toBe(16);
    expect(out[1]).toBeCloseTo(3 / 48);
    expect(out[15]).toBeCloseTo(45 / 48);
  });

  it("encodes 16-bit little-endian and clips", () => {
    const bytes = toPcm16(Float32Array.from([0, 1, -1, 2]));
    const view = new DataView(bytes.buffer);
    expect([0, 1, 2, 3].map((i) => view.getInt16(i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });

  it("encodes base64 for large inputs", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    const decoded = Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });

  it("gives 0 for silence and stays at most 1", () => {
    expect(level(new Float32Array(128))).toBe(0);
    expect(level(new Float32Array(128).fill(1))).toBe(1);
  });
});
