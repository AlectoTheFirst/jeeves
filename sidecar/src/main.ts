// Jeeves brain: the sidecar process. It owns all network calls and the Claude Code
// session, and routes what the user says.
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentSession, type PermissionAsk } from "./agent.ts";
import { classifyYesNo, isStopCommand, matchOption } from "./intent.ts";
import { PROTOCOL_VERSION, encode, parseToBrain, type AgentState, type FromBrain, type Question } from "./protocol.ts";
import { loadSettings, saveSettings, type BrainSettings } from "./settings.ts";
import { permissionQuestion, splitReply, toolPhrase } from "./spoken.ts";
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

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------- configuration

const voice: VoiceConfig = {
  apiKey: process.env.ELEVENLABS_API_KEY ?? "",
  voiceId: process.env.JEEVES_VOICE_ID ?? "0VTvMuu0nAzA04VFVeG2", // Paul Hampton, library voice.
  modelId: process.env.JEEVES_TTS_MODEL ?? "eleven_flash_v2_5",
  stability: 0.4,
  similarityBoost: 0.75,
  style: 0.3,
  speed: 1.05,
};

// JEEVES_STT_KEYTERMS: comma-separated words to expect, for example names.
const stt: SttOptions = {
  languageCode: process.env.JEEVES_STT_LANGUAGE ?? "en",
  keyterms: (process.env.JEEVES_STT_KEYTERMS ?? "Claude,Claude Code,Jeeves")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),
};

// ---------------------------------------------------------------- speech out

// Only 1 utterance streams at a time. A new one stops the old one.
let streaming: AbortController | null = null;

async function speak(id: number, text: string): Promise<void> {
  streaming?.abort();
  const controller = new AbortController();
  streaming = controller;
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
    send({ type: "speech_error", id, msg: errorText(err) });
    sayDone(id);
  } finally {
    if (streaming === controller) streaming = null;
  }
}

// Lines that the brain says go in a queue. The next line starts when the webview
// reports that the last 1 finished playing.
const BRAIN_SPEECH_BASE = 1_000_000; // The webview's own speech IDs stay below this.
let nextBrainSpeechId = BRAIN_SPEECH_BASE;
const sayQueue: string[] = [];
let sayingId: number | null = null;
let sayTimer: ReturnType<typeof setTimeout> | undefined;

function say(text: string): void {
  const clean = text.trim();
  if (!clean) return;
  sayQueue.push(clean);
  pumpSay();
}

function pumpSay(): void {
  if (sayingId !== null) return;
  const text = sayQueue.shift();
  if (text === undefined) return;
  const id = nextBrainSpeechId++;
  sayingId = id;
  // If the webview never reports the end, do not block the queue for ever.
  sayTimer = setTimeout(() => sayDone(id), 15_000 + text.length * 120);
  void speak(id, text);
}

function sayDone(id: number): void {
  if (sayingId !== id) return;
  clearTimeout(sayTimer);
  sayingId = null;
  pumpSay();
}

function stopAllSpeech(): void {
  sayQueue.length = 0;
  clearTimeout(sayTimer);
  sayingId = null;
  streaming?.abort();
  streaming = null;
}

// ---------------------------------------------------------------- open requests

type OpenPermission = { kind: "permission"; id: number; resolve: (allow: boolean) => void };
type OpenQuestion = {
  kind: "question";
  id: number;
  questions: Question[];
  answers: Record<string, string>;
  resolve: (answers: Record<string, string> | null) => void;
};
type OpenRequest = OpenPermission | OpenQuestion;

let nextRequestId = 1;
const openRequests = new Map<number, OpenRequest>();

function closeRequest(id: number): OpenRequest | undefined {
  const req = openRequests.get(id);
  if (!req) return undefined;
  openRequests.delete(id);
  send({ type: "request_closed", id });
  return req;
}

function answerPermission(id: number, allow: boolean): void {
  const req = closeRequest(id);
  if (req?.kind === "permission") req.resolve(allow);
}

function answerQuestion(id: number, answers: Record<string, string> | null): void {
  const req = closeRequest(id);
  if (req?.kind === "question") req.resolve(answers);
}

/** Decline every open request, for example after an interrupt. */
function declineAll(): void {
  for (const id of [...openRequests.keys()]) {
    const req = openRequests.get(id)!;
    if (req.kind === "permission") answerPermission(id, false);
    else answerQuestion(id, null);
  }
}

const spokenOptions = (q: Question) => {
  const labels = q.options.map((o) => o.label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}?` : `${labels[0]}?`;
};

/** The first question that has no answer yet. */
const nextOpenQuestion = (req: OpenQuestion) => req.questions.find((q) => !(q.question in req.answers));

function permissionDetail(ask: PermissionAsk): string {
  const str = (key: string) => (typeof ask.input[key] === "string" ? (ask.input[key] as string) : "");
  const detail = str("command") || str("file_path") || str("url") || JSON.stringify(ask.input);
  return [ask.description, detail].filter(Boolean).join("\n").slice(0, 600);
}

function toQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.map((q: Record<string, unknown>) => ({
    question: String(q.question ?? ""),
    header: String(q.header ?? ""),
    multiSelect: Boolean(q.multiSelect),
    options: (Array.isArray(q.options) ? q.options : []).map((o: Record<string, unknown>) => ({
      label: String(o.label ?? ""),
      description: String(o.description ?? ""),
    })),
  }));
}

// ---------------------------------------------------------------- agent

let settings: BrainSettings = { sessions: {} };
let session: AgentSession | null = null;
let agentState: AgentState = "no_project";
let agentMsg = "";
/** Set when a resumed session fails before it starts, to try once without resume. */
let sessionStarted = false;
let lastSpoken = "";
let turnStartedAt = 0;
let lastToolSpokenAt = 0;

function setAgentState(state: AgentState, msg = ""): void {
  agentState = state;
  agentMsg = msg;
  send({ type: "agent_status", state, project: settings.project ?? "", msg });
}

function startSession(resume = true): void {
  session?.close();
  const project = settings.project;
  if (!project) {
    setAgentState("no_project");
    return;
  }
  sessionStarted = false;
  const resumeId = resume ? settings.sessions[project] : undefined;
  session = new AgentSession(project, agentHost, resumeId);
  session.start();
  // The SDK sends its init message only after the first user message, and it queues
  // input until then. So the session is ready for input now.
  setAgentState("ready");
  log("info", `agent: starting in ${project}${resumeId ? ` (resume ${resumeId})` : ""}`);
}

function onAgentMessage(msg: SDKMessage): void {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        sessionStarted = true;
        if (settings.project && settings.sessions[settings.project] !== msg.session_id) {
          settings.sessions[settings.project] = msg.session_id;
          saveSettings(settings).catch((err) => log("warn", `settings: ${errorText(err)}`));
        }
        if (agentState !== "busy") setAgentState("ready");
      }
      break;
    case "assistant": {
      // Only the main agent. Helper agents work quietly.
      if (msg.parent_tool_use_id !== null) break;
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) {
          const { spoken, display } = splitReply(block.text);
          lastSpoken = spoken;
          if (display) send({ type: "agent_text", text: display });
        } else if (block.type === "tool_use") {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const phrase = toolPhrase(block.name, input);
          send({ type: "agent_tool", tool: block.name, phrase });
          // A short spoken status only in long turns, and not too often.
          const now = Date.now();
          if (phrase && now - turnStartedAt > 6_000 && now - lastToolSpokenAt > 15_000) {
            lastToolSpokenAt = now;
            say(phrase);
          }
        }
      }
      break;
    }
    case "result": {
      const ok = msg.subtype === "success" && !msg.is_error;
      if (ok) {
        say(lastSpoken || splitReply(msg.result).spoken || "Done.");
      } else {
        say("That did not work. The details are on screen.");
        const errors = "errors" in msg && Array.isArray(msg.errors) ? msg.errors.join("\n") : msg.subtype;
        send({ type: "agent_text", text: `Fault: ${errors}` });
      }
      lastSpoken = "";
      send({ type: "agent_result", ok, costUsd: msg.total_cost_usd, turns: msg.num_turns });
      setAgentState("ready");
      break;
    }
  }
}

const agentHost = {
  onMessage: (msg: SDKMessage) => {
    try {
      onAgentMessage(msg);
    } catch (err) {
      log("error", `agent message: ${errorText(err)}`);
    }
  },
  onFault: (err: unknown) => {
    declineAll();
    const project = settings.project;
    // A saved session can be gone. Start a new 1 once instead.
    if (!sessionStarted && project && settings.sessions[project]) {
      log("warn", `agent: resume failed (${errorText(err)}), starting a new session`);
      delete settings.sessions[project];
      saveSettings(settings).catch(() => {});
      startSession(false);
      return;
    }
    log("error", `agent: ${errorText(err)}`);
    session = null;
    setAgentState("fault", errorText(err).slice(0, 300));
    say("Something broke in my circuits. The details are on screen.");
  },
  askPermission: (ask: PermissionAsk) =>
    new Promise<boolean>((resolvePromise) => {
      const id = nextRequestId++;
      openRequests.set(id, { kind: "permission", id, resolve: resolvePromise });
      const text = permissionQuestion(ask.tool, ask.input, ask.title);
      send({ type: "permission_request", id, text, detail: permissionDetail(ask) });
      say(text);
      ask.signal.addEventListener("abort", () => answerPermission(id, false), { once: true });
    }),
  askQuestions: (input: Record<string, unknown>, signal: AbortSignal) =>
    new Promise<Record<string, string> | null>((resolvePromise) => {
      const questions = toQuestions(input);
      if (questions.length === 0) {
        resolvePromise(null);
        return;
      }
      const id = nextRequestId++;
      openRequests.set(id, { kind: "question", id, questions, answers: {}, resolve: resolvePromise });
      send({ type: "question", id, questions });
      say(`${questions[0].question} ${spokenOptions(questions[0])}`);
      signal.addEventListener("abort", () => answerQuestion(id, null), { once: true });
    }),
};

async function setProject(path: string): Promise<void> {
  const full = resolve(path.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  try {
    if (!statSync(full).isDirectory()) throw new Error("not a folder");
  } catch {
    send({ type: "agent_status", state: agentState, project: settings.project ?? "", msg: `Not a folder: ${full}` });
    return;
  }
  declineAll();
  settings.project = full;
  await saveSettings(settings).catch((err) => log("warn", `settings: ${errorText(err)}`));
  startSession();
}

// ---------------------------------------------------------------- what the user says

/** Route 1 user utterance (spoken or typed). */
function route(text: string): void {
  const t = text.trim();
  if (!t) return;

  // An open request comes first: the oldest 1.
  const req = openRequests.values().next().value as OpenRequest | undefined;
  if (req?.kind === "permission") {
    const answer = classifyYesNo(t);
    if (answer === "unclear") say("Sorry, was that a yes or a no?");
    else answerPermission(req.id, answer === "allow");
    return;
  }
  if (req?.kind === "question") {
    const q = nextOpenQuestion(req);
    if (q) {
      const index = matchOption(t, q.options.map((o) => o.label));
      if (index < 0) {
        say(`Sorry, which one? ${spokenOptions(q)}`);
        return;
      }
      req.answers[q.question] = q.options[index].label;
      const next = nextOpenQuestion(req);
      if (next) say(`${next.question} ${spokenOptions(next)}`);
      else answerQuestion(req.id, req.answers);
    }
    return;
  }

  if (isStopCommand(t)) {
    if (agentState === "busy") void interrupt();
    return;
  }
  if (!settings.project) {
    say("Give me a project folder first. Type it in the panel.");
    return;
  }
  // After a fault there is no session. Start a new 1; it reads the queued message.
  if (!session || agentState === "fault") startSession();
  turnStartedAt = Date.now();
  lastToolSpokenAt = 0;
  setAgentState("busy");
  session!.send(t);
}

async function interrupt(): Promise<void> {
  declineAll();
  stopAllSpeech();
  try {
    await session?.interrupt();
    say("Stopped.");
  } catch (err) {
    log("warn", `interrupt: ${errorText(err)}`);
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
    log("info", `stt: language ${result.language} (${result.probability.toFixed(2)})`);
    send({ type: "transcript", id, text: result.text });
    route(result.text);
  } catch (err) {
    send({ type: "transcript_error", id, msg: errorText(err) });
  }
}

// ---------------------------------------------------------------- stdin loop

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
      // The webview can connect late. Give it the current agent state.
      send({ type: "agent_status", state: agentState, project: settings.project ?? "", msg: agentMsg });
      break;
    case "speak":
      // Dev panel text: it replaces whatever the brain says.
      stopAllSpeech();
      sayingId = msg.id;
      void speak(msg.id, msg.text);
      break;
    case "stop_speech":
      stopAllSpeech();
      break;
    case "speech_done":
      sayDone(msg.id);
      break;
    case "transcribe":
      void handleTranscribe(msg.id, msg.audio);
      break;
    case "user_text":
      route(msg.text);
      break;
    case "permission_answer":
      answerPermission(msg.id, msg.allow);
      break;
    case "question_answer":
      answerQuestion(msg.id, msg.answers);
      break;
    case "interrupt":
      void interrupt();
      break;
    case "set_project":
      void setProject(msg.path);
      break;
  }
});

// The Rust core closes stdin when the app quits. Stop with it.
input.on("close", () => {
  session?.close();
  process.exit(0);
});

send({ type: "ready", protocol: PROTOCOL_VERSION });
log("info", voice.apiKey ? "ElevenLabs key found" : "no ElevenLabs key");
log("info", process.env.ANTHROPIC_API_KEY ? "agent auth: Anthropic API key" : "agent auth: Claude Code login");

settings = await loadSettings();
startSession();
