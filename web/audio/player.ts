// Plays streamed speech chunks in order, with the glitch effect chain, and gives the
// mouth pose for the current audio time.
//
// Timing facts from a live test of the ElevenLabs stream:
//   - Character times count from the start of the whole speech.
//   - Times do not arrive with their audio. 1 chunk can carry the times for many
//     later chunks, and most chunks carry no characters.
// So the player keeps 1 list of characters in speech time, and converts the audio
// clock to speech time for each frame (see clock.ts).
//
// Glitch chain (all controlled by 1 glitch level, 0 to 1. At 0 the voice plays clean):
//   - stutter: repeat the start of some words (see stutter.ts)
//   - pitch wobble: small random detune steps
//   - "TV speaker": band-limited copy of the voice with a bit-crush, mixed in
import type { SpeechChunk } from "../../sidecar/src/protocol.ts";
import type { MouthPose } from "../scene/head.ts";
import { playbackStartOf, toSpeechTime, type Insert } from "./clock.ts";
import { applyStutter, wordStarts, type StutterPick } from "./stutter.ts";
import { poseAt, VISEME_POSES, type TimedChar } from "./visemes.ts";

/** Time from the first chunk to the start of playback, to absorb network jitter. */
const START_DELAY = 0.15;
/** A late chunk counts as a gap only above this, so tiny clock errors do not add up. */
const MIN_GAP = 0.005;

function decodePcm16(base64: string): Float32Array {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

function crushCurve(bits: number): Float32Array<ArrayBuffer> {
  const size = 4096;
  const steps = 2 ** bits;
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

export type PlayerEvents = {
  onStart?: (id: number) => void;
  onEnd?: (id: number) => void;
  /** A stutter block starts now. Duration in milliseconds. */
  onStutter?: (durationMs: number) => void;
};

export class SpeechPlayer {
  private ctx = new AudioContext();
  private input: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private crusher: WaveShaperNode;
  private glitchLevel = 0.5;

  private id: number | null = null;
  private started = false;
  private finished = false;
  /** AudioContext time when speech time 0 plays. */
  private startTime = 0;
  /** AudioContext time when the queued audio ends. */
  private nextTime = 0;
  /** Speech seconds of audio received so far. */
  private received = 0;
  /** All characters so far, in speech time, in order. */
  private chars: TimedChar[] = [];
  private inserts: Insert[] = [];
  /** AudioContext times of stutter blocks that did not start yet. */
  private stutters: { time: number; duration: number }[] = [];
  private sources: AudioBufferSourceNode[] = [];

  constructor(private events: PlayerEvents = {}) {
    this.input = this.ctx.createGain();
    this.dry = this.ctx.createGain();
    this.wet = this.ctx.createGain();
    const highpass = this.ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 380;
    const lowpass = this.ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 4200;
    lowpass.Q.value = 2;
    this.crusher = this.ctx.createWaveShaper();

    this.input.connect(this.dry).connect(this.ctx.destination);
    this.input.connect(highpass).connect(lowpass).connect(this.crusher).connect(this.wet).connect(this.ctx.destination);
    this.setGlitchLevel(this.glitchLevel);
  }

  /** 0 = clean voice, 1 = full broken-TV voice. */
  setGlitchLevel(level: number): void {
    this.glitchLevel = Math.min(Math.max(level, 0), 1);
    const g = this.glitchLevel;
    this.dry.gain.value = 1 - g * 0.55;
    this.wet.gain.value = g * 0.9;
    this.crusher.curve = crushCurve(Math.round(14 - g * 9));
  }

  getGlitchLevel(): number {
    return this.glitchLevel;
  }

  /** Browsers start an AudioContext only after a user action. Call this from 1. */
  unlock(): void {
    void this.ctx.resume();
  }

  get active(): boolean {
    return this.id !== null;
  }

  /** Stop all sound now and forget the current utterance. */
  stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // The source did not start yet, or it stopped already.
      }
    }
    const id = this.id;
    const wasStarted = this.started;
    this.reset();
    if (id !== null && wasStarted) this.events.onEnd?.(id);
  }

  private reset(): void {
    this.id = null;
    this.started = false;
    this.finished = false;
    this.received = 0;
    this.chars = [];
    this.inserts = [];
    this.stutters = [];
    this.sources = [];
  }

  addChunk(chunk: SpeechChunk): void {
    if (this.id !== chunk.id) {
      this.stop();
      this.id = chunk.id;
      this.startTime = this.ctx.currentTime + START_DELAY;
      this.nextTime = this.startTime;
    }
    for (let i = 0; i < chunk.chars.length; i++) {
      this.chars.push({ char: chunk.chars[i], start: chunk.starts[i], end: chunk.ends[i] });
    }

    const raw = decodePcm16(chunk.audio);
    if (raw.length === 0) return;
    const chunkStart = this.received;
    this.received += raw.length / chunk.sampleRate;

    // A late chunk leaves silence. Record it, so the mouth stays in sync after it.
    const at = Math.max(this.nextTime, this.ctx.currentTime);
    if (at - this.nextTime > MIN_GAP) {
      this.inserts.push({ at: chunkStart, total: at - this.nextTime, kind: "gap", slice: 0 });
    }

    // Stutters only on word starts whose times are already known and inside this chunk.
    const local = this.chars
      .filter((c) => c.start >= chunkStart && c.start < this.received)
      .map((c) => ({ char: c.char, start: c.start - chunkStart, end: c.end - chunkStart }));
    const { samples, events } = applyStutter(raw, chunk.sampleRate, [], this.pickStutters(local));
    for (const e of events) {
      const ins: Insert = { at: chunkStart + e.at, total: e.duration, kind: "repeat", slice: e.slice };
      const playAt = this.startTime + playbackStartOf(this.inserts, ins.at);
      this.inserts.push(ins);
      this.stutters.push({ time: playAt, duration: e.duration });
    }

    const buffer = this.ctx.createBuffer(1, samples.length, chunk.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.input);
    this.scheduleWobble(source, at, buffer.duration);
    source.start(at);
    this.sources.push(source);
    this.nextTime = at + buffer.duration;
  }

  /** The brain sent all chunks for this utterance. */
  finish(id: number): void {
    if (this.id === id) this.finished = true;
  }

  private pickStutters(local: readonly TimedChar[]): StutterPick[] {
    const g = this.glitchLevel;
    if (g <= 0) return [];
    const picks: StutterPick[] = [];
    for (const i of wordStarts(local.map((c) => c.char))) {
      if (Math.random() < g * 0.3) {
        picks.push({
          at: local[i].start,
          slice: 0.06 + Math.random() * 0.04,
          repeats: 1 + Math.floor(Math.random() * (g > 0.7 ? 3 : 2)),
        });
      }
    }
    return picks;
  }

  private scheduleWobble(source: AudioBufferSourceNode, at: number, duration: number): void {
    const g = this.glitchLevel;
    if (g <= 0) return;
    let t = 0;
    while (t < duration) {
      // Random steps around 0 cents, so the average speed (and the lip-sync) stays the same.
      source.detune.setValueAtTime((Math.random() - 0.5) * 2 * g * 45, at + t);
      t += 0.08 + Math.random() * 0.15;
    }
  }

  /** Call once per frame. Returns the mouth pose, or null when nothing plays. */
  update(): MouthPose | null {
    if (this.id === null) return null;
    const now = this.ctx.currentTime;
    if (!this.started && this.sources.length > 0 && now >= this.startTime) {
      this.started = true;
      this.events.onStart?.(this.id);
    }
    while (this.stutters.length > 0 && this.stutters[0].time <= now) {
      const s = this.stutters.shift()!;
      this.events.onStutter?.(s.duration * 1000);
    }
    if (this.finished && now >= this.nextTime) {
      const id = this.id;
      this.reset();
      this.events.onEnd?.(id);
      return null;
    }
    if (!this.started) return VISEME_POSES.rest;
    const speech = toSpeechTime(this.inserts, now - this.startTime);
    return speech.silent ? VISEME_POSES.rest : poseAt(this.chars, speech.t);
  }
}
