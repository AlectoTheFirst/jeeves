// Messages between the webview (through the Rust core) and the sidecar brain.
// Transport: 1 JSON object per line on the sidecar stdin and stdout.

export const PROTOCOL_VERSION = 1;

/** Messages that go to the brain. */
export type ToBrain =
  | { type: "ping"; id: number }
  | { type: "speak"; id: number; text: string }
  | { type: "stop_speech" };

/** 1 piece of speech audio with the timing of each character in it. */
export type SpeechChunk = {
  type: "speech_chunk";
  id: number;
  seq: number;
  /** Base64 of 16-bit little-endian mono PCM. */
  audio: string;
  sampleRate: number;
  chars: string[];
  /** Seconds, as ElevenLabs gives them. */
  starts: number[];
  ends: number[];
};

/** Messages that come from the brain. */
export type FromBrain =
  | { type: "ready"; protocol: number }
  | { type: "pong"; id: number; protocol: number }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string }
  | SpeechChunk
  | { type: "speech_end"; id: number }
  | { type: "speech_error"; id: number; msg: string };

const TO_BRAIN_TYPES = new Set<ToBrain["type"]>(["ping", "speak", "stop_speech"]);
const FROM_BRAIN_TYPES = new Set<FromBrain["type"]>([
  "ready",
  "pong",
  "log",
  "speech_chunk",
  "speech_end",
  "speech_error",
]);

const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === "number");
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

function parseObject(line: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Parse 1 line for the brain. Returns null if the line is not a known message. */
export function parseToBrain(line: string): ToBrain | null {
  const obj = parseObject(line);
  if (!obj || !TO_BRAIN_TYPES.has(obj.type as ToBrain["type"])) return null;
  switch (obj.type) {
    case "ping":
      return typeof obj.id === "number" ? { type: "ping", id: obj.id } : null;
    case "speak":
      return typeof obj.id === "number" && typeof obj.text === "string"
        ? { type: "speak", id: obj.id, text: obj.text }
        : null;
    case "stop_speech":
      return { type: "stop_speech" };
  }
  return null;
}

/** Parse 1 line from the brain. Returns null if the line is not a known message. */
export function parseFromBrain(line: string): FromBrain | null {
  const obj = parseObject(line);
  if (!obj || !FROM_BRAIN_TYPES.has(obj.type as FromBrain["type"])) return null;
  switch (obj.type) {
    case "ready":
      return typeof obj.protocol === "number" ? { type: "ready", protocol: obj.protocol } : null;
    case "pong":
      return typeof obj.id === "number" && typeof obj.protocol === "number"
        ? { type: "pong", id: obj.id, protocol: obj.protocol }
        : null;
    case "log":
      return (obj.level === "info" || obj.level === "warn" || obj.level === "error") &&
        typeof obj.msg === "string"
        ? { type: "log", level: obj.level, msg: obj.msg }
        : null;
    case "speech_chunk": {
      const { id, seq, audio, sampleRate, chars, starts, ends } = obj;
      if (
        typeof id !== "number" ||
        typeof seq !== "number" ||
        typeof audio !== "string" ||
        typeof sampleRate !== "number" ||
        !isStringArray(chars) ||
        !isNumberArray(starts) ||
        !isNumberArray(ends) ||
        starts.length !== chars.length ||
        ends.length !== chars.length
      ) {
        return null;
      }
      return { type: "speech_chunk", id, seq, audio, sampleRate, chars, starts, ends };
    }
    case "speech_end":
      return typeof obj.id === "number" ? { type: "speech_end", id: obj.id } : null;
    case "speech_error":
      return typeof obj.id === "number" && typeof obj.msg === "string"
        ? { type: "speech_error", id: obj.id, msg: obj.msg }
        : null;
  }
  return null;
}

export function encode(msg: ToBrain | FromBrain): string {
  return JSON.stringify(msg);
}
