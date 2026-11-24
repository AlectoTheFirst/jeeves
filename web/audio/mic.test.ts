import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDead, MicRecorder, peakOf, SILENCE_PEAK, trimDeadStart } from "./mic.ts";

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

const RATE = 8000;

class FakeTrack {
  readyState: "live" | "ended" = "live";
  muted = false;
  stop() {
    this.readyState = "ended";
  }
}

class FakeNode {
  static last: FakeNode;
  port: { onmessage: ((e: { data: Float32Array }) => void) | null } = { onmessage: null };
  constructor() {
    FakeNode.last = this;
  }
  disconnect() {}
}

class FakeContext {
  sampleRate = RATE;
  state = "running";
  audioWorklet = { addModule: async () => {} };
  resume = async () => {};
  close = async () => {};
  createMediaStreamSource() {
    return { connect() {} };
  }
}

function send(blocks: number, value = 0.5): void {
  for (let i = 0; i < blocks; i++) FakeNode.last.port.onmessage!({ data: new Float32Array(128).fill(value) });
}

describe("MicRecorder", () => {
  let tracks: FakeTrack[];

  beforeEach(() => {
    tracks = [];
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", FakeContext);
    vi.stubGlobal("AudioWorkletNode", FakeNode);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () => {
          const track = new FakeTrack();
          tracks.push(track);
          return { getAudioTracks: () => [track], getTracks: () => [track] };
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports the maximum length once per recording", async () => {
    const onMaxLength = vi.fn();
    const mic = new MicRecorder({ onMaxLength });
    await mic.start();
    send(Math.ceil((RATE * 60) / 128) + 50);
    expect(onMaxLength).toHaveBeenCalledTimes(1);
    mic.stop();
    await mic.start();
    send(Math.ceil((RATE * 60) / 128));
    expect(onMaxLength).toHaveBeenCalledTimes(2);
  });

  it("reports the maximum length again after a kept tail", async () => {
    const onMaxLength = vi.fn();
    const mic = new MicRecorder({ onMaxLength });
    await mic.start();
    send(Math.ceil((RATE * 60) / 128));
    expect(onMaxLength).toHaveBeenCalledTimes(1);
    const kept = mic.stopAfterTail(() => true);
    await vi.advanceTimersByTimeAsync(300);
    expect(await kept).toBeUndefined();
    send(1);
    expect(onMaxLength).toHaveBeenCalledTimes(2);
  });

  it("gives the result of a recording to the first tail only", async () => {
    const mic = new MicRecorder();
    await mic.start();
    send(100);
    const first = mic.stopAfterTail(() => false);
    const second = mic.stopAfterTail(() => false);
    await vi.advanceTimersByTimeAsync(300);
    expect((await first)?.kind).toBe("audio");
    expect(await second).toBeUndefined();
    expect(mic.isRecording).toBe(false);
  });

  it("starts a new tail after the last one ended", async () => {
    const mic = new MicRecorder();
    await mic.start();
    send(100);
    const kept = mic.stopAfterTail(() => true);
    await vi.advanceTimersByTimeAsync(300);
    expect(await kept).toBeUndefined();
    const done = mic.stopAfterTail(() => false);
    await vi.advanceTimersByTimeAsync(300);
    expect((await done)?.kind).toBe("audio");
  });

  it("opens the mic again after its track ended", async () => {
    const mic = new MicRecorder();
    await mic.start();
    mic.stop();
    await mic.start();
    mic.stop();
    expect(tracks).toHaveLength(1);
    tracks[0].readyState = "ended";
    await mic.start();
    expect(tracks).toHaveLength(2);
    send(100);
    expect(mic.stop().kind).toBe("audio");
  });
});
