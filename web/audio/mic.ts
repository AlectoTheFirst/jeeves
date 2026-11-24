// Push-to-talk mic capture. Collects raw samples while it records, then gives
// 16 kHz PCM for speech to text.
//
// The mic opens at the first press and then stays open. A short pre-roll keeps
// the start of the first word.
import { level, resample, STT_RATE, toBase64, toPcm16 } from "./pcm.ts";

/** Recordings shorter than this are taps, not speech. */
const MIN_SECONDS = 0.3;
/** Stop at this length, so a stuck key does not record forever. */
const MAX_SECONDS = 60;
/** Recording time after the key comes up. People release the key before the last sound ends. */
const TAIL_MS = 300;
/** Audio from before the key went down that goes into the recording. */
const PREROLL_SECONDS = 0.3;
/** A recording with a lower peak comes from a dead mic. The service guesses words from noise. */
export const SILENCE_PEAK = 0.003;

// The worklet copies each 128-sample block to the main thread. Inline, so that the
// build does not need a separate file.
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice());
    return true;
  }
}
registerProcessor("jeeves-capture", Capture);
`;

export type MicEvents = {
  /** Mic level, 0 to 1, about 30 times per second while recording. */
  onLevel?: (value: number) => void;
  /** The recording hit the maximum length and stopped by itself. */
  onMaxLength?: () => void;
  /**
   * The first real sound of a recording arrived. A mic that was idle can give exact
   * zeros for some time after a start. `wakeMs` is that time, 0 if the mic was live.
   */
  onLive?: (wakeMs: number) => void;
};

/** The result of a recording. */
export type Recording =
  | { kind: "audio"; audio: string; peak: number }
  | { kind: "short" }
  | { kind: "silent"; peak: number };

/** True if the block is digital silence: exact zeros, which a live mic never gives. */
export const isDead = (block: Float32Array) => block.every((x) => x === 0);

/** Remove the exact zeros at the start, from a mic that was not live yet. */
export function trimDeadStart(samples: Float32Array): Float32Array {
  const first = samples.findIndex((x) => x !== 0);
  return first < 0 ? new Float32Array(0) : samples.subarray(first);
}

export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private opening: Promise<void> | null = null;
  private tail: Promise<Recording | undefined> | null = null;
  private blocks: Float32Array[] = [];
  private samples = 0;
  private preroll: Float32Array[] = [];
  private recording = false;
  private live = false;
  private maxed = false;
  private startedAt = 0;
  private levelAcc: Float32Array[] = [];

  constructor(private events: MicEvents = {}) {}

  get isRecording(): boolean {
    return this.recording;
  }

  /** True when the current recording has real sound from the mic. */
  get isLive(): boolean {
    return this.live;
  }

  /** Mic state for the status line, when a recording is silent. */
  diagnose(): string {
    const track = this.stream?.getAudioTracks()[0];
    if (!track || !this.ctx) return "mic closed";
    return `track ${track.readyState}${track.muted ? " muted" : ""}, audio ${this.ctx.state}`;
  }

  /** Open the mic. The first call asks the user for permission. */
  private open(): Promise<void> {
    // A track ends when its device goes away. An ended track gives no sound.
    if (!this.recording && this.stream && !this.stream.getAudioTracks().some((t) => t.readyState === "live")) {
      this.close();
    }
    this.opening ??= this.doOpen().catch((err) => {
      this.opening = null;
      throw err;
    });
    return this.opening;
  }

  private close(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.node?.disconnect();
    void this.ctx?.close().catch(() => {});
    this.stream = null;
    this.node = null;
    this.ctx = null;
    this.opening = null;
    this.preroll = [];
  }

  private async doOpen(): Promise<void> {
    const t0 = performance.now();
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Browser noise suppression can damage speech for STT. Echo cancellation is not
      // needed, because the head stops speaking when the user talks.
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "jeeves-capture");
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onBlock(e.data);
    source.connect(this.node);
    console.info(`[mic] open in ${Math.round(performance.now() - t0)} ms`);
  }

  private onBlock(block: Float32Array): void {
    if (!this.ctx) return;
    if (!this.recording) {
      this.preroll.push(block);
      while (this.preroll.length * 128 > this.ctx.sampleRate * PREROLL_SECONDS) this.preroll.shift();
      return;
    }
    this.blocks.push(block);
    this.samples += block.length;
    if (!this.live && !isDead(block)) {
      this.live = true;
      this.events.onLive?.(Math.round(performance.now() - this.startedAt));
    }
    this.levelAcc.push(block);
    // About 30 level updates per second.
    if (this.levelAcc.length * 128 >= this.ctx.sampleRate / 30) {
      this.events.onLevel?.(level(join(this.levelAcc)));
      this.levelAcc = [];
    }
    if (!this.maxed && this.samples >= this.ctx.sampleRate * MAX_SECONDS) {
      this.maxed = true;
      this.events.onMaxLength?.();
    }
  }

  /**
   * Open the mic and start the audio before the first recording. The audio stalls for
   * about 1 s when the mic opens, and that must not happen while the user talks.
   */
  async warmUp(): Promise<void> {
    await this.open();
    await this.ctx!.resume();
  }

  async start(): Promise<void> {
    await this.open();
    await this.ctx!.resume();
    this.blocks = this.preroll;
    this.samples = this.preroll.reduce((n, b) => n + b.length, 0);
    this.preroll = [];
    this.levelAcc = [];
    this.startedAt = performance.now();
    this.live = this.blocks.some((b) => !isDead(b));
    this.maxed = false;
    this.recording = true;
    if (this.live) this.events.onLive?.(0);
  }

  /**
   * Stop after a short tail, so that the last word is not cut off.
   * If `keep()` is true at the end of the tail, the recording continues and the
   * result is undefined. A kept recording at the 60 s limit calls `onMaxLength`
   * again at the next block. A call during a running tail returns undefined, and the
   * running tail gives the result.
   */
  stopAfterTail(keep: () => boolean): Promise<Recording | undefined> {
    if (!this.recording) return Promise.resolve({ kind: "short" });
    if (this.tail) return Promise.resolve(undefined);
    const tail = new Promise<void>((resolve) => setTimeout(resolve, TAIL_MS)).then(() => {
      this.tail = null;
      if (!keep()) return this.stop();
      this.maxed = false;
      return undefined;
    });
    this.tail = tail;
    return tail;
  }

  /** Stop now. The audio is base64 PCM (16 kHz, 16-bit, mono). */
  stop(): Recording {
    if (!this.recording || !this.ctx) return { kind: "short" };
    this.recording = false;
    this.events.onLevel?.(0);
    const rate = this.ctx.sampleRate;
    const all = trimDeadStart(join(this.blocks));
    this.blocks = [];
    this.live = false;
    // Only zeros: the mic never gave sound. That is not a short tap.
    if (all.length === 0) return { kind: "silent", peak: 0 };
    if (all.length < rate * MIN_SECONDS) return { kind: "short" };
    const peak = peakOf(all);
    if (peak < SILENCE_PEAK) return { kind: "silent", peak };
    return { kind: "audio", peak, audio: toBase64(toPcm16(resample(all, rate, STT_RATE))) };
  }
}

function join(blocks: Float32Array[]): Float32Array {
  const all = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of blocks) {
    all.set(b, offset);
    offset += b.length;
  }
  return all;
}
