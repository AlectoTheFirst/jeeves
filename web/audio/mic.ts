// Push-to-talk mic capture. Collects raw samples while it records, then gives
// 16 kHz PCM for speech to text.
import { level, resample, STT_RATE, toBase64, toPcm16 } from "./pcm.ts";

/** Recordings shorter than this are taps, not speech. */
const MIN_SECONDS = 0.3;
/** Stop at this length, so a stuck key does not record forever. */
const MAX_SECONDS = 60;
/** Recording time after the key comes up. People release the key before the last sound ends. */
const TAIL_MS = 300;

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
};

export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private blocks: Float32Array[] = [];
  private samples = 0;
  private recording = false;
  private levelAcc: Float32Array[] = [];

  constructor(private events: MicEvents = {}) {}

  get isRecording(): boolean {
    return this.recording;
  }

  /** Open the mic. The first call asks the user for permission. */
  private async open(): Promise<void> {
    if (this.ctx && this.node) return;
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
  }

  private onBlock(block: Float32Array): void {
    if (!this.recording || !this.ctx) return;
    this.blocks.push(block);
    this.samples += block.length;
    this.levelAcc.push(block);
    // About 30 level updates per second.
    if (this.levelAcc.length * 128 >= this.ctx.sampleRate / 30) {
      const joined = new Float32Array(this.levelAcc.reduce((n, b) => n + b.length, 0));
      let o = 0;
      for (const b of this.levelAcc) {
        joined.set(b, o);
        o += b.length;
      }
      this.levelAcc = [];
      this.events.onLevel?.(level(joined));
    }
    if (this.samples >= this.ctx.sampleRate * MAX_SECONDS) this.events.onMaxLength?.();
  }

  async start(): Promise<void> {
    await this.open();
    await this.ctx!.resume();
    this.blocks = [];
    this.samples = 0;
    this.levelAcc = [];
    this.recording = true;
  }

  /**
   * Stop after a short tail, so that the last word is not cut off.
   * Returns base64 PCM (16 kHz, 16-bit, mono), or null for a short tap.
   * If `keep()` is true at the end of the tail, the recording continues and the
   * result is undefined.
   */
  async stopAfterTail(keep: () => boolean): Promise<string | null | undefined> {
    if (!this.recording) return null;
    await new Promise((resolve) => setTimeout(resolve, TAIL_MS));
    if (keep()) return undefined;
    return this.stop();
  }

  /** Stop now. Returns base64 PCM (16 kHz, 16-bit, mono), or null for a short tap. */
  stop(): string | null {
    if (!this.recording || !this.ctx) return null;
    this.recording = false;
    this.events.onLevel?.(0);
    const rate = this.ctx.sampleRate;
    if (this.samples < rate * MIN_SECONDS) return null;
    const all = new Float32Array(this.samples);
    let offset = 0;
    for (const b of this.blocks) {
      all.set(b, offset);
      offset += b.length;
    }
    this.blocks = [];
    return toBase64(toPcm16(resample(all, rate, STT_RATE)));
  }
}
