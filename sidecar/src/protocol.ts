// Messages between the webview (through the Rust core) and the sidecar brain.
// Transport: 1 JSON object per line on the sidecar stdin and stdout.
import { parseConfig, type Config } from "./config.ts";

export const PROTOCOL_VERSION = 1;

/** Messages that go to the brain. */
export type ToBrain =
  | { type: "ping"; id: number }
  | { type: "speak"; id: number; text: string }
  | { type: "stop_speech" }
  /** `audio`: base64 of 16-bit little-endian mono PCM at 16 kHz. */
  | { type: "transcribe"; id: number; audio: string }
  /** The webview finished playing a speech. The brain then says the next queued line. */
  | { type: "speech_done"; id: number }
  /** Typed text for the agent (the voice path goes through "transcribe"). */
  | { type: "user_text"; text: string }
  | { type: "permission_answer"; id: number; allow: boolean }
  /** `answers`: option label for each question text, or null to decline. */
  | { type: "question_answer"; id: number; answers: Record<string, string> | null }
  | { type: "interrupt" }
  | { type: "set_project"; path: string }
  /** The full config from the settings view. The brain checks it, saves it and sends it back. */
  | { type: "set_config"; config: Config }
  /** Ask for the voices in the user's ElevenLabs account. */
  | { type: "list_voices" }
  /** Ask for the MCP servers of the session and their status. */
  | { type: "list_mcp" }
  /** The window got or lost the focus. */
  | { type: "focus"; focused: boolean }
  /** Start the cost count again at 0. */
  | { type: "reset_cost" };

/** The spend since the last cost reset. `blocked`: the cost limit stops new requests. */
export type CostInfo = { spentUsd: number; budgetUsd: number; requests: number; since: number; blocked: boolean };

export type VoiceInfo = { id: string; name: string; category: string };

export type McpStatus = {
  name: string;
  /** connected, failed, needs-auth, pending or disabled. */
  status: string;
  /** Where the server comes from: user, project, plugin, claudeai, dynamic (Jeeves) and more. */
  source: string;
  error: string;
  tools: number;
};

export type AgentState = "no_project" | "starting" | "ready" | "busy" | "fault";

export type QuestionOption = { label: string; description: string };
export type Question = { question: string; header: string; options: QuestionOption[]; multiSelect: boolean };

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
  | { type: "speech_error"; id: number; msg: string }
  | { type: "transcript"; id: number; text: string }
  | { type: "transcript_error"; id: number; msg: string }
  | { type: "agent_status"; state: AgentState; project: string; msg: string }
  /** Full assistant text for the log. */
  | { type: "agent_text"; text: string }
  /** The spoken summary of a reply, for the transcript. `more`: the log has more detail. */
  | { type: "agent_said"; text: string; more: boolean }
  /** A tool started. `phrase` is short and can be empty. */
  | { type: "agent_tool"; tool: string; phrase: string }
  | { type: "permission_request"; id: number; text: string; detail: string }
  | { type: "question"; id: number; questions: Question[] }
  /** A permission request or question is answered or no longer open. */
  | { type: "request_closed"; id: number }
  | { type: "agent_result"; ok: boolean; costUsd: number; turns: number }
  /** The current config. `keys`: which API keys the brain has. */
  | { type: "config"; config: Config; keys: { elevenlabs: boolean; anthropic: boolean } }
  | { type: "voices"; voices: VoiceInfo[]; error: string }
  /** `error` is set when the brain could not get the status, for example without a session. */
  | { type: "mcp_status"; servers: McpStatus[]; error: string }
  /** Recent project folders, the newest first. */
  | { type: "projects"; recent: string[] }
  | ({ type: "cost" } & CostInfo);

const TO_BRAIN_TYPES = new Set<ToBrain["type"]>([
  "ping",
  "speak",
  "stop_speech",
  "transcribe",
  "speech_done",
  "user_text",
  "permission_answer",
  "question_answer",
  "interrupt",
  "set_project",
  "set_config",
  "list_voices",
  "list_mcp",
  "focus",
  "reset_cost",
]);
const AGENT_STATES = new Set<AgentState>(["no_project", "starting", "ready", "busy", "fault"]);
const FROM_BRAIN_TYPES = new Set<FromBrain["type"]>([
  "ready",
  "pong",
  "log",
  "speech_chunk",
  "speech_end",
  "speech_error",
  "transcript",
  "transcript_error",
  "agent_status",
  "agent_text",
  "agent_said",
  "agent_tool",
  "permission_request",
  "question",
  "request_closed",
  "agent_result",
  "config",
  "voices",
  "mcp_status",
  "projects",
  "cost",
]);

const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((s) => typeof s === "string");

const isQuestion = (v: unknown): v is Question => {
  if (typeof v !== "object" || v === null) return false;
  const q = v as Record<string, unknown>;
  return (
    typeof q.question === "string" &&
    typeof q.header === "string" &&
    typeof q.multiSelect === "boolean" &&
    Array.isArray(q.options) &&
    q.options.every(
      (o) =>
        typeof o === "object" &&
        o !== null &&
        typeof (o as QuestionOption).label === "string" &&
        typeof (o as QuestionOption).description === "string",
    )
  );
};

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
    case "transcribe":
      return typeof obj.id === "number" && typeof obj.audio === "string"
        ? { type: "transcribe", id: obj.id, audio: obj.audio }
        : null;
    case "speech_done":
      return typeof obj.id === "number" ? { type: "speech_done", id: obj.id } : null;
    case "user_text":
      return typeof obj.text === "string" ? { type: "user_text", text: obj.text } : null;
    case "permission_answer":
      return typeof obj.id === "number" && typeof obj.allow === "boolean"
        ? { type: "permission_answer", id: obj.id, allow: obj.allow }
        : null;
    case "question_answer":
      return typeof obj.id === "number" && (obj.answers === null || isStringRecord(obj.answers))
        ? { type: "question_answer", id: obj.id, answers: obj.answers }
        : null;
    case "interrupt":
      return { type: "interrupt" };
    case "set_project":
      return typeof obj.path === "string" ? { type: "set_project", path: obj.path } : null;
    case "set_config":
      return typeof obj.config === "object" && obj.config !== null
        ? { type: "set_config", config: parseConfig(obj.config) }
        : null;
    case "list_voices":
      return { type: "list_voices" };
    case "list_mcp":
      return { type: "list_mcp" };
    case "focus":
      return typeof obj.focused === "boolean" ? { type: "focus", focused: obj.focused } : null;
    case "reset_cost":
      return { type: "reset_cost" };
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
    case "transcript_error":
      return typeof obj.id === "number" && typeof obj.msg === "string"
        ? { type: obj.type, id: obj.id, msg: obj.msg }
        : null;
    case "transcript":
      return typeof obj.id === "number" && typeof obj.text === "string"
        ? { type: "transcript", id: obj.id, text: obj.text }
        : null;
    case "agent_status":
      return AGENT_STATES.has(obj.state as AgentState) && typeof obj.project === "string" && typeof obj.msg === "string"
        ? { type: "agent_status", state: obj.state as AgentState, project: obj.project, msg: obj.msg }
        : null;
    case "agent_text":
      return typeof obj.text === "string" ? { type: "agent_text", text: obj.text } : null;
    case "agent_said":
      return typeof obj.text === "string" && typeof obj.more === "boolean"
        ? { type: "agent_said", text: obj.text, more: obj.more }
        : null;
    case "agent_tool":
      return typeof obj.tool === "string" && typeof obj.phrase === "string"
        ? { type: "agent_tool", tool: obj.tool, phrase: obj.phrase }
        : null;
    case "permission_request":
      return typeof obj.id === "number" && typeof obj.text === "string" && typeof obj.detail === "string"
        ? { type: "permission_request", id: obj.id, text: obj.text, detail: obj.detail }
        : null;
    case "question":
      return typeof obj.id === "number" && Array.isArray(obj.questions) && obj.questions.every(isQuestion)
        ? { type: "question", id: obj.id, questions: obj.questions }
        : null;
    case "request_closed":
      return typeof obj.id === "number" ? { type: "request_closed", id: obj.id } : null;
    case "agent_result":
      return typeof obj.ok === "boolean" && typeof obj.costUsd === "number" && typeof obj.turns === "number"
        ? { type: "agent_result", ok: obj.ok, costUsd: obj.costUsd, turns: obj.turns }
        : null;
    case "config": {
      const keys = obj.keys as Record<string, unknown> | null;
      return typeof obj.config === "object" &&
        obj.config !== null &&
        typeof keys === "object" &&
        keys !== null &&
        typeof keys.elevenlabs === "boolean" &&
        typeof keys.anthropic === "boolean"
        ? { type: "config", config: parseConfig(obj.config), keys: { elevenlabs: keys.elevenlabs, anthropic: keys.anthropic } }
        : null;
    }
    case "voices":
      return Array.isArray(obj.voices) &&
        typeof obj.error === "string" &&
        obj.voices.every(
          (v) =>
            typeof v === "object" &&
            v !== null &&
            typeof (v as VoiceInfo).id === "string" &&
            typeof (v as VoiceInfo).name === "string" &&
            typeof (v as VoiceInfo).category === "string",
        )
        ? { type: "voices", voices: obj.voices as VoiceInfo[], error: obj.error }
        : null;
    case "mcp_status":
      return Array.isArray(obj.servers) &&
        typeof obj.error === "string" &&
        obj.servers.every((v) => {
          const s = v as Record<string, unknown>;
          return (
            typeof v === "object" &&
            v !== null &&
            ["name", "status", "source", "error"].every((k) => typeof s[k] === "string") &&
            typeof s.tools === "number"
          );
        })
        ? { type: "mcp_status", servers: obj.servers as McpStatus[], error: obj.error }
        : null;
    case "projects":
      return isStringArray(obj.recent) ? { type: "projects", recent: obj.recent } : null;
    case "cost": {
      const { spentUsd, budgetUsd, requests, since, blocked } = obj;
      return typeof spentUsd === "number" &&
        typeof budgetUsd === "number" &&
        typeof requests === "number" &&
        typeof since === "number" &&
        typeof blocked === "boolean"
        ? { type: "cost", spentUsd, budgetUsd, requests, since, blocked }
        : null;
    }
  }
  return null;
}

export function encode(msg: ToBrain | FromBrain): string {
  return JSON.stringify(msg);
}
