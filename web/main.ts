import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { encode, parseFromBrain, type AgentState, type FromBrain, type ToBrain } from "../sidecar/src/protocol.ts";
import { MicRecorder } from "./audio/mic.ts";
import { SpeechPlayer } from "./audio/player.ts";
import { HeadScene } from "./scene/head.ts";
import { HEAD_STATES } from "./scene/state.ts";
import { toPlainText } from "./ui/plain.ts";
import { RequestCards } from "./ui/requests.ts";
import { Transcript } from "./ui/transcript.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const status = $("status");
const transcript = new Transcript($("transcript"));
const head = new HeadScene($<HTMLCanvasElement>("scene"));
head.start();
if (import.meta.env.DEV) document.body.classList.add("dev");

function setStatus(text: string): void {
  status.textContent = text;
}

async function sendToBrain(msg: ToBrain): Promise<void> {
  await invoke("brain_send", { line: encode(msg) });
}

// ---------------------------------------------------------------- head state

let agentState: AgentState = "no_project";

/** The state to show when the head is not speaking or listening. */
function restState(): void {
  if (player.active || mic.isRecording) return;
  if (cards.openCount > 0) head.setState("permission");
  else if (agentState === "busy" || agentState === "starting") head.setState("thinking");
  else head.setState("idle");
}

// ---------------------------------------------------------------- speech out

const player = new SpeechPlayer({
  onStart: () => head.setState("speaking"),
  onEnd: (id) => {
    head.setMouth({ jaw: 0, wide: 0, round: 0 });
    void sendToBrain({ type: "speech_done", id });
    restState();
  },
  onStutter: (ms) => head.glitch(0.35 + player.getGlitchLevel() * 0.5, ms),
});

// Lip-sync: read the mouth pose from the audio clock every frame.
function lipSyncFrame(): void {
  const pose = player.update();
  if (pose) head.setMouth(pose);
  requestAnimationFrame(lipSyncFrame);
}
requestAnimationFrame(lipSyncFrame);

let nextSpeechId = 1;

function stopSpeech(): void {
  void sendToBrain({ type: "stop_speech" });
  player.stop();
}

// ---------------------------------------------------------------- requests

const cards = new RequestCards($("requests"), {
  permission: (id, allow) => void sendToBrain({ type: "permission_answer", id, allow }),
  question: (id, answers) => void sendToBrain({ type: "question_answer", id, answers }),
});

// ---------------------------------------------------------------- brain messages

const pendingTranscripts = new Map<number, HTMLElement>();

function onBrainMessage(msg: FromBrain): void {
  switch (msg.type) {
    case "ready":
      setStatus("brain ready");
      void sendToBrain({ type: "ping", id: Date.now() });
      break;
    case "pong":
      break;
    case "log":
      console[msg.level](`[brain] ${msg.msg}`);
      break;
    case "speech_chunk":
      player.addChunk(msg);
      break;
    case "speech_end":
      player.finish(msg.id);
      break;
    case "speech_error":
      player.stop();
      setStatus(`voice fault: ${msg.msg.slice(0, 120)}`);
      console.error(`[voice] ${msg.msg}`);
      restState();
      break;
    case "transcript":
    case "transcript_error": {
      const line = pendingTranscripts.get(msg.id);
      pendingTranscripts.delete(msg.id);
      if (msg.type === "transcript_error") {
        if (line) transcript.remove(line);
        setStatus(`hearing fault: ${msg.msg.slice(0, 120)}`);
        console.error(`[stt] ${msg.msg}`);
      } else if (line) {
        if (msg.text) transcript.settle(line, msg.text);
        else transcript.remove(line);
      }
      restState();
      break;
    }
    case "agent_status": {
      agentState = msg.state;
      const project = msg.project.split("/").filter(Boolean).at(-1) ?? "";
      const label: Record<AgentState, string> = {
        no_project: "no project: press S",
        starting: `starting ${project}`,
        ready: `ready: ${project}`,
        busy: `working: ${project}`,
        fault: `fault: ${msg.msg}`,
      };
      setStatus(msg.msg && msg.state !== "fault" ? msg.msg : label[msg.state]);
      if (msg.project) projectInput.value = msg.project;
      restState();
      break;
    }
    case "agent_text":
      transcript.add("head", toPlainText(msg.text));
      break;
    case "agent_tool":
      if (msg.phrase) {
        transcript.add("tool", msg.phrase);
        setStatus(msg.phrase);
      }
      break;
    case "permission_request":
      cards.showPermission(msg.id, msg.text, msg.detail);
      restState();
      break;
    case "question":
      cards.showQuestion(msg.id, msg.questions);
      restState();
      break;
    case "request_closed":
      cards.close(msg.id);
      restState();
      break;
    case "agent_result":
      setStatus(`${msg.ok ? "done" : "failed"}: ${msg.turns} turns, $${msg.costUsd.toFixed(3)}`);
      break;
  }
}

async function connectBrain(): Promise<void> {
  if (!isTauri()) {
    setStatus("browser preview: no brain");
    return;
  }
  await listen<string>("brain", (event) => {
    const msg = parseFromBrain(event.payload);
    if (msg) onBrainMessage(msg);
  });
  // The brain can be ready before the listener exists. Ask for its state directly too.
  await sendToBrain({ type: "ping", id: Date.now() });
}

connectBrain().catch((err) => setStatus(`brain fault: ${String(err)}`));

// ---------------------------------------------------------------- push-to-talk

let nextTranscriptId = 1;
/** True while the push-to-talk key is down. */
let wantListening = false;

const mic = new MicRecorder({
  onLevel: (value) => head.setListenLevel(value),
  onMaxLength: () => void stopListening(),
});

async function startListening(): Promise<void> {
  wantListening = true;
  if (mic.isRecording) return;
  player.unlock();
  // Talking over the head stops it, as with a person.
  if (player.active) stopSpeech();
  try {
    await mic.start();
    // The key came up while the mic opened (for example, during the permission prompt).
    if (!wantListening) {
      mic.stop();
      restState();
      return;
    }
    head.setState("listening");
    setStatus("listening");
  } catch (err) {
    setStatus(`mic fault: ${String(err).slice(0, 120)}`);
  }
}

async function stopListening(): Promise<void> {
  wantListening = false;
  if (!mic.isRecording) return;
  const result = await mic.stopAfterTail(() => wantListening);
  // The key went down again during the tail: it is still the same recording.
  if (result === undefined) return;
  if (result.kind !== "audio") {
    setStatus(result.kind === "short" ? "too short" : "no speech heard");
    if (result.kind === "silent") setStatus(`no speech heard (${mic.diagnose()}, peak ${result.peak.toFixed(3)})`);
    restState();
    return;
  }
  const audio = result.audio;
  const id = nextTranscriptId++;
  pendingTranscripts.set(id, transcript.add("user", "...", true));
  head.setState("thinking");
  setStatus(`transcribing (peak ${result.peak.toFixed(3)})`);
  await sendToBrain({ type: "transcribe", id, audio });
}

const isTyping = (e: KeyboardEvent) =>
  e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;

/** Space is push-to-talk outside text fields, and in the text box while it is empty. */
const isTalkKey = (e: KeyboardEvent) =>
  e.code === "Space" && (!isTyping(e) || (e.target === textInput && textInput.value === ""));

window.addEventListener("keydown", (e) => {
  // While the mic records, a held Space must not type spaces anywhere.
  if (e.code === "Space" && wantListening) {
    e.preventDefault();
    return;
  }
  if (isTalkKey(e) && !e.repeat) {
    e.preventDefault();
    void startListening();
    return;
  }
  if (isTyping(e)) return;
  if (e.key === "Escape") {
    stopSpeech();
    void sendToBrain({ type: "interrupt" });
  } else if (e.key === "s") {
    togglePanel();
  } else if (e.key === "t") {
    setStatus(transcript.togglePinned() ? "transcript: always show" : "transcript: hide after 10 s");
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || !wantListening) return;
  e.preventDefault();
  void stopListening();
});
// If the window loses focus while the key is down, the keyup never comes.
window.addEventListener("blur", () => void stopListening());

// ---------------------------------------------------------------- panel

const panel = $<HTMLFormElement>("panel");
const projectInput = $<HTMLInputElement>("project");
const textInput = $<HTMLTextAreaElement>("text");
const glitch = $<HTMLInputElement>("glitch");

function togglePanel(): void {
  panel.hidden = !panel.hidden;
  panel.classList.remove("fading");
  if (!panel.hidden) {
    (projectInput.value ? textInput : projectInput).focus();
    armPanelFade();
  }
}

// The panel fades away after some time with no activity. S shows it again.
const PANEL_IDLE_MS = 5000;
const PANEL_FADE_MS = 400;
let panelFadeTimer: number | undefined;

function armPanelFade(): void {
  clearTimeout(panelFadeTimer);
  panel.classList.remove("fading");
  if (panel.hidden) return;
  panelFadeTimer = window.setTimeout(fadePanel, PANEL_IDLE_MS);
}

function fadePanel(): void {
  // Keep the panel while the pointer is on it or while a draft is in the text box.
  if (panel.matches(":hover") || textInput.value.trim()) {
    armPanelFade();
    return;
  }
  panel.classList.add("fading");
  panelFadeTimer = window.setTimeout(() => {
    panel.hidden = true;
    panel.classList.remove("fading");
    // Give the keys back to the head, so that Space is push-to-talk.
    if (panel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }, PANEL_FADE_MS);
}

for (const event of ["input", "keydown", "pointermove", "focusin"]) {
  panel.addEventListener(event, armPanelFade);
}

$("project-set").addEventListener("click", () => {
  const path = projectInput.value.trim();
  if (!path) return;
  void sendToBrain({ type: "set_project", path });
  // Paths can have spaces, so Space types in this field. Move on to the text box.
  textInput.focus();
});
projectInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("project-set").click();
  }
});

panel.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  player.unlock();
  transcript.add("user", text);
  textInput.value = "";
  void sendToBrain({ type: "user_text", text });
});
textInput.addEventListener("keydown", (e) => {
  // Enter sends. Shift+Enter makes a new line. Escape leaves the text box.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    panel.requestSubmit();
  } else if (e.key === "Escape") {
    textInput.blur();
  }
});

$("speak").addEventListener("click", () => {
  const text = textInput.value.trim();
  if (!text) return;
  player.unlock();
  player.stop();
  void sendToBrain({ type: "speak", id: nextSpeechId++, text });
});
$("stop").addEventListener("click", () => {
  stopSpeech();
  void sendToBrain({ type: "interrupt" });
});
glitch.addEventListener("input", () => {
  $("glitch-value").textContent = glitch.value;
  player.setGlitchLevel(Number(glitch.value) / 100);
});

// ---------------------------------------------------------------- dev keys

// 1-5: state   G: glitch   B: backdrop
if (import.meta.env.DEV) {
  window.addEventListener("keydown", (e) => {
    if (isTyping(e)) return;
    const index = Number(e.key) - 1;
    if (index >= 0 && index < HEAD_STATES.length) {
      head.setState(HEAD_STATES[index]);
      setStatus(`state: ${HEAD_STATES[index]}`);
    } else if (e.key === "g") {
      head.glitch(1, 400);
    } else if (e.key === "b") {
      head.setBackdrop(!head.backdropOn);
    }
  });
}
