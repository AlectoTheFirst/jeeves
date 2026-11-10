// Messages between the webview (through the Rust core) and the sidecar brain.
// Transport: 1 JSON object per line on the sidecar stdin and stdout.

export const PROTOCOL_VERSION = 1;

/** Messages that go to the brain. */
export type ToBrain = { type: "ping"; id: number };

/** Messages that come from the brain. */
export type FromBrain =
  | { type: "ready"; protocol: number }
  | { type: "pong"; id: number; protocol: number }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string };

const TO_BRAIN_TYPES = new Set<ToBrain["type"]>(["ping"]);
const FROM_BRAIN_TYPES = new Set<FromBrain["type"]>(["ready", "pong", "log"]);

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
  if (obj.type === "ping" && typeof obj.id === "number") return { type: "ping", id: obj.id };
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
  }
  return null;
}

export function encode(msg: ToBrain | FromBrain): string {
  return JSON.stringify(msg);
}
