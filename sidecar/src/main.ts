// Jeeves brain: the sidecar process.
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION, encode, parseToBrain, type FromBrain } from "./protocol.ts";
import { pcm16ToWav, transcribe, type SttOptions } from "./stt.ts";
import { SAMPLE_RATE, streamSpeech, type VoiceConfig } from "./voice.ts";

function send(msg: FromBrain): void {
  process.stdout.write(encode(msg) + "\n");
}

function log(level: "info" | "warn" | "error", msg: string): void {
  send({ type: "log", level, msg });
  // The Rust core prints stderr lines in its own log, which is easier to read in dev.
  process.stderr.write(`${level}: ${msg}\n`);
}

// Milestone 5 moves these values to the settings file.
const voice: VoiceConfig = {
  apiKey: process.env.ELEVENLABS_API_KEY ?? "",
  voiceId: process.env.JEEVES_VOICE_ID ?? "0VTvMuu0nAzA04VFVeG2", // Paul Hampton, library voice.
  modelId: process.env.JEEVES_TTS_MODEL ?? "eleven_flash_v2_5",
  stability: 0.4,
  similarityBoost: 0.75,
  style: 0.3,
  speed: 1.05,
};

// Milestone 5 moves these values to the settings file too.
// JEEVES_STT_KEYTERMS: comma-separated words to expect, for example names.
const stt: SttOptions = {
  languageCode: process.env.JEEVES_STT_LANGUAGE ?? "en",
  keyterms: (process.env.JEEVES_STT_KEYTERMS ?? "Claude,Claude Code,Jeeves")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),
};

// Only 1 utterance plays at a time. A new speak request stops the old one.
let current: AbortController | null = null;

async function speak(id: number, text: string): Promise<void> {
  current?.abort();
  const controller = new AbortController();
  current = controller;
  if (!voice.apiKey) {
    send({ type: "speech_error", id, msg: "No ElevenLabs API key. Store it in the Keychain (service 'jeeves', account 'elevenlabs')." });
    return;
  }
  try {
    let seq = 0;
    for await (const chunk of streamSpeech(voice, text, controller.signal)) {
      send({ type: "speech_chunk", id, seq: seq++, sampleRate: SAMPLE_RATE, ...chunk });
    }
    send({ type: "speech_end", id });
  } catch (err) {
    if (controller.signal.aborted) return;
    send({ type: "speech_error", id, msg: err instanceof Error ? err.message : String(err) });
  } finally {
    if (current === controller) current = null;
  }
}

async function handleTranscribe(id: number, audio: string): Promise<void> {
  if (!voice.apiKey) {
    send({ type: "transcript_error", id, msg: "No ElevenLabs API key." });
    return;
  }
  // Keep the last recording on disk, to find faults in the audio path.
  const wavPath = join(tmpdir(), "jeeves-last-recording.wav");
  writeFile(wavPath, pcm16ToWav(Buffer.from(audio, "base64"))).catch(() => {});
  try {
    const result = await transcribe(voice.apiKey, audio, stt);
    log("info", `stt: language ${result.language} (${result.probability.toFixed(2)}), audio in ${wavPath}`);
    send({ type: "transcript", id, text: result.text });
  } catch (err) {
    send({ type: "transcript_error", id, msg: err instanceof Error ? err.message : String(err) });
  }
}

// A recording arrives as 1 long line. readline has no line length limit.
const input = createInterface({ input: process.stdin });

input.on("line", (line) => {
  const msg = parseToBrain(line);
  if (!msg) {
    log("warn", `unknown message: ${line.slice(0, 200)}`);
    return;
  }
  switch (msg.type) {
    case "ping":
      send({ type: "pong", id: msg.id, protocol: PROTOCOL_VERSION });
      break;
    case "speak":
      void speak(msg.id, msg.text);
      break;
    case "stop_speech":
      current?.abort();
      current = null;
      break;
    case "transcribe":
      void handleTranscribe(msg.id, msg.audio);
      break;
  }
});

// The Rust core closes stdin when the app quits. Stop with it.
input.on("close", () => process.exit(0));

send({ type: "ready", protocol: PROTOCOL_VERSION });
log("info", voice.apiKey ? "ElevenLabs key found" : "no ElevenLabs key");
