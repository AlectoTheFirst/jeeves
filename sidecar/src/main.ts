// Jeeves brain: the sidecar process. It owns all network calls and the agent
// session, and routes what the user says.
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createAgent, type AgentMessage, type PermissionAsk, type CreateAgentOptions, type BrainAgent } from "./agents/index.ts";
import { loadClaudeProjects, mergeProjects } from "./claudeProjects.ts";
import { addRecent, costDelta, isBlocked, rememberTotal } from "./cost.ts";
import { classifyYesNo, isStopCommand, matchOption, matchProject, parseProjectSwitch } from "./intent.ts";
import { PROTOCOL_VERSION, encode, parseToBrain, type AgentState, type FromBrain, type Question } from "./protocol.ts";
import { characterFor, characterNote, mcpToolPrefix, parseConfig, personaPrompt, type Config } from "./config.ts";
import { emptySettings, loadSettings, saveSettings, type BrainSettings } from "./settings.ts";
import { permissionQuestion, splitReply, toolPhrase } from "./spoken.ts";
import { pcm16ToWav, transcribe, type SttOptions } from "./stt.ts";
import { listVoices, SAMPLE_RATE, streamSpeech, type VoiceConfig } from "./voice.ts";

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

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY ?? "";

/** The settings view edits this. It is saved in the settings file. */
let config: Config = parseConfig(undefined);

/** The voice of the active face. */
function currentVoice(): VoiceConfig {
  const v = characterFor(config).voice;
  return {
    apiKey: ELEVENLABS_KEY,
    voiceId: v.voiceId,
    modelId: v.model,
    stability: v.stability,
    similarityBoost: 0.75,
    style: v.style,
    speed: v.speed,
  };
}

function sttOptions(): SttOptions {
  return { languageCode: config.hearing.language, keyterms: config.hearing.keyterms };
}

function sendConfig(): void {
  send({ type: "config", config, keys: { elevenlabs: Boolean(ELEVENLABS_KEY), anthropic: Boolean(process.env.ANTHROPIC_API_KEY) } });
}

function sendCost(): void {
  const { usd, requests, since } = settings.spend;
  const budgetUsd = config.agent.budgetUsd;
  send({ type: "cost", spentUsd: usd, budgetUsd, requests, since, blocked: isBlocked(settings.spend, budgetUsd) });
}

/** The Jeeves recent folders, then the Claude Code projects if the setting is on. */
function knownProjects(): string[] {
  return mergeProjects(settings.recent, config.agent.useClaudeProjects ? loadClaudeProjects() : [], settings.project);
}

function sendProjects(): void {
  send({ type: "projects", recent: knownProjects() });
}

function saveSoon(): void {
  saveSettings(settings).catch((err) => log("warn", `settings: ${errorText(err)}`));
}

/** The session options that come from the config. A change needs a session restart. */
function sessionOptions(): CreateAgentOptions {
  const mcpServers: Record<string, any> = {};
  for (const [name, s] of Object.entries(config.mcp.servers)) {
    mcpServers[name] =
      s.type === "stdio"
        ? { type: "stdio", command: s.command, args: s.args, env: s.env }
        : s.type === "http"
          ? { type: "http", url: s.url, headers: s.headers }
          : { type: "sse", url: s.url, headers: s.headers };
  }
  return {
    provider: config.agent.provider,
    model: config.agent.model,
    persona: personaPrompt(characterFor(config).behavior),
    mcpServers,
    strictMcpConfig: !config.mcp.useClaudeCode,
    trustedTools: config.mcp.trusted.map(mcpToolPrefix),
  };
}

async function sendMcpStatus(): Promise<void> {
  if (!session) {
    send({ type: "mcp_status", servers: [], error: "No agent session. Choose a project folder first." });
    return;
  }
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer in 15 s")), 15_000));
    const list = await Promise.race([session.mcpStatus(), timeout]);
    send({
      type: "mcp_status",
      servers: list.map((s) => ({
        name: s.name,
        status: s.status,
        source: s.source ?? s.scope ?? "",
        error: s.error ?? "",
        tools: s.tools?.length ?? 0,
      })),
      error: "",
    });
  } catch (err) {
    send({ type: "mcp_status", servers: [], error: errorText(err) });
  }
}

let restartWhenIdle = false;
/** Goes in front of the next user message after a resume. Read characterNote(). */
let pendingCharacterNote: string | null = null;

async function setConfig(next: Config): Promise<void> {
  const before = JSON.stringify(sessionOptions());
  const projectsChanged = next.agent.useClaudeProjects !== config.agent.useClaudeProjects;
  config = next;
  settings.config = config;
  await saveSettings(settings).catch((err) => log("warn", `settings: ${errorText(err)}`));
  sendConfig();
  sendCost();
  if (projectsChanged) sendProjects();
  // A new model or personality needs a new session. Resume keeps the conversation.
  if (session && JSON.stringify(sessionOptions()) !== before) {
    if (agentState === "busy") restartWhenIdle = true;
    else {
      startSession(true);
      // New MCP servers need some seconds to connect.
      setTimeout(() => void sendMcpStatus(), 5_000);
    }
  }
}

async function sendVoices(): Promise<void> {
  if (!ELEVENLABS_KEY) {
    send({ type: "voices", voices: [], error: "No ElevenLabs API key." });
    return;
  }
  try {
    send({ type: "voices", voices: await listVoices(ELEVENLABS_KEY), error: "" });
  } catch (err) {
    send({ type: "voices", voices: [], error: errorText(err) });
  }
}

// ---------------------------------------------------------------- speech out

// Only 1 utterance streams at a time. A new one stops the old one.
let streaming: AbortController | null = null;

async function speak(id: number, text: string): Promise<void> {
  streaming?.abort();
  const controller = new AbortController();
  streaming = controller;
  const voice = currentVoice();
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
/** `stale`: a tool update, which has no worth after a hold. */
const sayQueue: { text: string; stale: boolean }[] = [];
let sayingId: number | null = null;
let sayTimer: ReturnType<typeof setTimeout> | undefined;
/** The webview sends this. With "hold speech", lines wait while the window has no focus. */
let windowFocused = true;
let held = false;

function say(text: string, kind: "line" | "tool" = "line"): void {
  const clean = text.trim();
  if (!clean) return;
  sayQueue.push({ text: clean, stale: kind === "tool" });
  pumpSay();
}

function setWindowFocus(focused: boolean): void {
  windowFocused = focused;
  if (!focused) return;
  if (held) {
    // Tool updates from the time away are old news.
    held = false;
    for (let i = sayQueue.length - 1; i >= 0; i--) if (sayQueue[i].stale) sayQueue.splice(i, 1);
  }
  pumpSay();
}

function pumpSay(): void {
  if (sayingId !== null || sayQueue.length === 0) return;
  if (config.attention.holdSpeech && !windowFocused) {
    held = true;
    return;
  }
  const text = sayQueue.shift()!.text;
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
  held = false;
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

let settings: BrainSettings = emptySettings();
let session: BrainAgent | null = null;
let agentState: AgentState = "no_project";
let agentMsg = "";
/** Set when a resumed session fails before it starts, to try once without resume. */
let sessionStarted = false;
let lastSpoken = "";
/** True when this turn sent text to the log that the spoken summary does not hold. */
let turnHasDetail = false;
let turnStartedAt = 0;
let lastToolSpokenAt = 0;
/** The session ID from the init message, and if the session was resumed. For the cost count. */
let sessionId = "";
let sessionResumed = false;
let resumeIdUsed: string | undefined;

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
  sessionId = "";
  sessionResumed = false;
  resumeIdUsed = resumeId;
  restartWhenIdle = false;
  // A resumed conversation can have answers from another character.
  pendingCharacterNote = resumeId ? characterNote(characterFor(config).behavior) : null;
  session = createAgent(project, agentHost, resumeId, sessionOptions());
  session.start();
  // The SDK sends its init message only after the first user message, and it queues
  // input until then. So the session is ready for input now.
  setAgentState("ready");
  log("info", `agent: starting as ${characterFor(config).behavior.name} in ${project}${resumeId ? ` (resume ${resumeId})` : ""}`);
}

function onAgentMessage(msg: AgentMessage): void {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        sessionStarted = true;
        sessionId = msg.session_id;
        // The API agent makes a new ID at each start. Only the same ID carries old cost.
        sessionResumed = msg.session_id === resumeIdUsed;
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
          if (display && display !== spoken) turnHasDetail = true;
          if (display) send({ type: "agent_text", text: display });
        } else if (block.type === "tool_use") {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const phrase = toolPhrase(block.name, input);
          send({ type: "agent_tool", tool: block.name, phrase });
          // A short spoken status only in long turns, and not too often.
          const now = Date.now();
          const chatty = characterFor(config).behavior.toolUpdates;
          if (chatty && phrase && now - turnStartedAt > 6_000 && now - lastToolSpokenAt > 15_000) {
            lastToolSpokenAt = now;
            say(phrase, "tool");
          }
        }
      }
      break;
    }
    case "result": {
      const ok = msg.subtype === "success" && !msg.is_error;
      let said: string;
      if (ok) {
        said = lastSpoken || splitReply(msg.result).spoken || "Done.";
      } else {
        said = "That did not work. The details are in the log.";
        const errors = "errors" in msg && Array.isArray(msg.errors) ? msg.errors.join("\n") : msg.subtype;
        send({ type: "agent_text", text: `Fault: ${errors}` });
        turnHasDetail = true;
      }
      // The transcript shows what the head says. The full text is in the log.
      say(said);
      send({ type: "agent_said", text: said, more: turnHasDetail });
      lastSpoken = "";
      turnHasDetail = false;
      countCost(msg.total_cost_usd);
      send({ type: "agent_result", ok, costUsd: msg.total_cost_usd, turns: msg.num_turns });
      setAgentState("ready");
      if (restartWhenIdle) {
        restartWhenIdle = false;
        startSession(true);
      }
      break;
    }
  }
}

function countCost(total: number): void {
  const key = sessionId || "unknown";
  const delta = costDelta(total, settings.sessionTotals[key], sessionResumed);
  settings.sessionTotals = rememberTotal(settings.sessionTotals, key, total);
  settings.spend = { ...settings.spend, usd: settings.spend.usd + delta, requests: settings.spend.requests + 1 };
  saveSoon();
  sendCost();
}

function resetCost(): void {
  settings.spend = { usd: 0, requests: 0, since: Date.now() };
  saveSoon();
  sendCost();
}

const agentHost = {
  onMessage: (msg: AgentMessage) => {
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
    say("Something broke in my circuits. The details are in the log.");
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
  settings.recent = addRecent(settings.recent, full);
  sendProjects();
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
  const switchTo = parseProjectSwitch(t);
  if (switchTo !== null) {
    const path = matchProject(switchTo, knownProjects());
    if (agentState === "busy") say("I am still at work. Say stop first, then switch.");
    else if (!path) say(`I do not know a recent project called ${switchTo}. Choose it in the panel.`);
    else if (path === settings.project) say("We are already in that project.");
    else {
      say(`Switching to ${path.split("/").filter(Boolean).at(-1)}.`);
      void setProject(path);
    }
    return;
  }
  if (isBlocked(settings.spend, config.agent.budgetUsd)) {
    say("The cost limit is reached. Raise it in the settings, or reset the cost in the log.");
    sendCost();
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
  turnHasDetail = false;
  setAgentState("busy");
  session!.send(pendingCharacterNote ? `${pendingCharacterNote}\n\n${t}` : t);
  pendingCharacterNote = null;
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
  if (!ELEVENLABS_KEY) {
    send({ type: "transcript_error", id, msg: "No ElevenLabs API key." });
    return;
  }
  // Keep the last recording on disk, to find faults in the audio path.
  const wavPath = join(tmpdir(), "jeeves-last-recording.wav");
  writeFile(wavPath, pcm16ToWav(Buffer.from(audio, "base64"))).catch(() => {});
  try {
    const result = await transcribe(ELEVENLABS_KEY, audio, sttOptions());
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
      sendConfig();
      sendProjects();
      sendCost();
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
    case "set_config":
      void setConfig(msg.config);
      break;
    case "list_voices":
      void sendVoices();
      break;
    case "list_mcp":
      void sendMcpStatus();
      break;
    case "focus":
      setWindowFocus(msg.focused);
      break;
    case "reset_cost":
      resetCost();
      break;
  }
});

// The Rust core closes stdin when the app quits. Stop with it.
input.on("close", () => {
  session?.close();
  process.exit(0);
});

send({ type: "ready", protocol: PROTOCOL_VERSION });
log("info", ELEVENLABS_KEY ? "ElevenLabs key found" : "no ElevenLabs key");
log("info", process.env.ANTHROPIC_API_KEY ? "agent auth: Anthropic API key" : "agent auth: Claude Code login");

settings = await loadSettings();
config = parseConfig(settings.config);
sendConfig();
sendProjects();
sendCost();
startSession();
