import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechChunk } from "../../sidecar/src/protocol.ts";
import { SpeechPlayer } from "./player.ts";

const node = () => ({ connect: (next: unknown) => next });

class FakeContext {
  currentTime = 0;
  destination = {};
  createGain = () => ({ ...node(), gain: { value: 1 } });
  createBiquadFilter = () => ({ ...node(), type: "", frequency: { value: 0 }, Q: { value: 0 } });
  createWaveShaper = () => ({ ...node(), curve: null });
  createBuffer = (_channels: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel: () => {} });
  createBufferSource = () => ({ ...node(), buffer: null, detune: { setValueAtTime: () => {} }, start: () => {}, stop: () => {} });
  resume = async () => {};
}

const chunk = (id: number): SpeechChunk => ({
  type: "speech_chunk",
  id,
  seq: 0,
  sampleRate: 16000,
  // 2 samples of 16-bit PCM.
  audio: btoa("\x00\x10\x00\x10"),
  chars: [],
  starts: [],
  ends: [],
});

describe("SpeechPlayer stop", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioContext", FakeContext);
  });

  it("drops late chunks of the stopped utterance", () => {
    const player = new SpeechPlayer();
    player.addChunk(chunk(5));
    expect(player.active).toBe(true);
    player.stop();
    player.addChunk(chunk(5));
    player.finish(5);
    expect(player.active).toBe(false);
  });

  it("plays the next utterance after a stop", () => {
    const player = new SpeechPlayer();
    player.addChunk(chunk(5));
    player.stop();
    player.addChunk(chunk(6));
    expect(player.active).toBe(true);
  });

  it("accepts the stopped id again after forgetStopped", () => {
    const player = new SpeechPlayer();
    player.addChunk(chunk(5));
    player.stop();
    player.forgetStopped();
    player.addChunk(chunk(5));
    expect(player.active).toBe(true);
  });
});
