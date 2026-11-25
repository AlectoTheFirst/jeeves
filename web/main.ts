import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, monitorFromPoint, primaryMonitor, UserAttentionType } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { characterFor, parseConfig, type Config } from "../sidecar/src/config.ts";
import { encode, parseFromBrain, type AgentState, type FromBrain, type ToBrain } from "../sidecar/src/protocol.ts";
import { MicRecorder } from "./audio/mic.ts";
import { SpeechPlayer } from "./audio/player.ts";
import { allFaces, faceById, setInstalledFaces, type Face } from "./scene/faces.ts";
import { loadFacePackage } from "./scene/faceLoader.ts";
import {
  isPackageFaceId,
  PACKAGE_PREFIX,
  packageFaceId,
  type FaceCatalog,
  type InstalledPackage,
  type InstallOutcome,
} from "./scene/facePackage.ts";
import { HeadScene } from "./scene/head.ts";
import { HEAD_STATES } from "./scene/state.ts";
import { RequestCards } from "./ui/requests.ts";
import { fitInto, sameRect, type Rect } from "./ui/fit.ts";
import { LogView } from "./ui/log.ts";
import { SettingsView } from "./ui/settings.ts";
import { Transcript } from "./ui/transcript.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const status = $("status");
const transcript = new Transcript($("transcript"));
// Browser preview: ?face=<id> picks a face.
const urlFace = new URLSearchParams(location.search).get("face");
const head = new HeadScene($<HTMLCanvasElement>("scene"), faceById(urlFace));
head.start();
if (import.meta.env.DEV) document.body.classList.add("dev");
// Name each source that the Content Security Policy blocks. In dev, Vite copies this to the terminal.
document.addEventListener("securitypolicyviolation", (e) =>
  console.warn(`[csp] blocked ${e.effectiveDirective}: ${e.blockedURI || "inline"} (${e.sourceFile}:${e.lineNumber})`),
);

function setStatus(text: string): void {
  status.textContent = text;
}

/** Returns false when the message did not reach the brain, for example during a restart. */
async function sendToBrain(msg: ToBrain): Promise<boolean> {
  try {
    await invoke("brain_send", { line: encode(msg) });
    return true;
  } catch (err) {
    console.error(`[brain] ${msg.type} not sent: ${String(err)}`);
    return false;
  }
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
      // A restarted brain does not know the focus state.
      void sendToBrain({ type: "focus", focused: windowFocused });
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
        if (msg.text) {
          transcript.settle(line, msg.text);
          logView.add("user", msg.text);
        } else transcript.remove(line);
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
      if (msg.state === "fault") logView.add("fault", msg.msg);
      if (msg.project) projectInput.value = msg.project;
      restState();
      break;
    }
    case "agent_text":
      // The full reply goes to the log only. The transcript gets the spoken summary.
      logView.add("head", msg.text);
      break;
    case "agent_said": {
      lastHeadText = msg.text;
      const line = transcript.add("head", msg.text);
      if (msg.more) {
        line.classList.add("more");
        line.title = "Show the full answer in the log (L)";
        line.addEventListener("click", () => openOverlay(logView));
      }
      break;
    }
    case "agent_tool":
      if (msg.phrase) {
        transcript.add("tool", msg.phrase);
        logView.add("tool", msg.phrase);
        setStatus(msg.phrase);
      }
      break;
    case "permission_request":
      cards.showPermission(msg.id, msg.text, msg.detail);
      callAttention(msg.text, msg.detail, UserAttentionType.Critical);
      restState();
      break;
    case "question":
      cards.showQuestion(msg.id, msg.questions);
      callAttention("A question for you", msg.questions[0]?.question ?? "", UserAttentionType.Critical);
      restState();
      break;
    case "request_closed":
      cards.close(msg.id);
      restState();
      break;
    case "config":
      applyConfig(msg.config, true);
      settingsView.setKeys(msg.keys);
      break;
    case "voices":
      settingsView.setVoices(msg.voices, msg.error);
      break;
    case "mcp_status":
      settingsView.setMcpStatus(msg.servers, msg.error);
      break;
    case "agent_result":
      setStatus(`${msg.ok ? "done" : "failed"}: ${msg.turns} turns, $${msg.costUsd.toFixed(3)} this session`);
      callAttention(msg.ok ? "Done" : "That did not work", lastHeadText || "The details are in the log.", UserAttentionType.Informational);
      break;
    case "projects":
      recentProjects.replaceChildren(...msg.recent.map((p) => new Option(p, p)));
      break;
    case "cost":
      logView.setCost(msg);
      if (msg.blocked) setStatus("cost limit reached: see the log (L)");
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
  await listen<BrainExit>("brain-exit", (event) => onBrainExit(event.payload));
  await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    windowFocused = focused;
    void sendToBrain({ type: "focus", focused });
    if (focused) void getCurrentWindow().requestUserAttention(null);
  });
  // The brain can be ready before the listener exists. Ask for its state directly too.
  if (!(await sendToBrain({ type: "ping", id: Date.now() }))) setStatus("brain fault: the ping was not sent");
}

connectBrain().catch((err) => setStatus(`brain fault: ${String(err)}`));

// ---------------------------------------------------------------- brain restart

type BrainExit = { code: number | null; restarting: boolean; delay_ms: number; attempt: number };

/** The brain stopped. Its open requests, speech and pending transcripts are gone. */
function onBrainExit(exit: BrainExit): void {
  player.stop();
  player.forgetStopped();
  cards.closeAll();
  for (const line of pendingTranscripts.values()) transcript.remove(line);
  pendingTranscripts.clear();
  agentState = "starting";
  const text = exit.restarting
    ? `brain stopped (code ${exit.code ?? "none"}), restart ${exit.attempt} in ${Math.round(exit.delay_ms / 1000)} s`
    : `brain fault: it stopped ${exit.attempt} times in a row. Restart Jeeves.`;
  setStatus(text);
  logView.add("fault", text);
  if (!exit.restarting) agentState = "fault";
  restState();
}

// ---------------------------------------------------------------- attention

let windowFocused = document.hasFocus();
/** The last agent text, for the notification of a finished request. */
let lastHeadText = "";

/** Notify and bounce the Dock icon, as the settings say, if the window has no focus. */
function callAttention(title: string, body: string, kind: UserAttentionType): void {
  if (!isTauri() || windowFocused) return;
  const name = characterFor(config).behavior.name;
  if (config.attention.notify) {
    void invoke("notify", { title: `${name}: ${title}`, body: body || title }).catch((e) => console.warn("notify", e));
  }
  if (config.attention.bounce) void getCurrentWindow().requestUserAttention(kind);
}

// ---------------------------------------------------------------- push-to-talk

let nextTranscriptId = 1;
/** True while the push-to-talk key is down. */
let wantListening = false;

const mic = new MicRecorder({
  onLevel: (value) => head.setListenLevel(value),
  onMaxLength: () => void stopListening(),
  // A mic that was idle can need some time to give sound. Show "listening" only then.
  onLive: (wakeMs) => {
    if (wakeMs > 0 && wantListening && mic.isRecording) showListening(wakeMs);
  },
});

// Open the mic early: at the start, and again at the first click (a browser can need
// a user action to start audio). The mic stalls for about 1 s when it opens.
if (isTauri()) {
  const warmUp = () => void mic.warmUp().catch((err) => console.warn(`[mic] warm-up: ${String(err)}`));
  warmUp();
  window.addEventListener("pointerdown", warmUp, { once: true });
}

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
    if (mic.isLive) showListening(0);
    else setStatus("mic starting, wait");
  } catch (err) {
    setStatus(`mic fault: ${String(err).slice(0, 120)}`);
  }
}

function showListening(wakeMs: number): void {
  head.setState("listening");
  setStatus(wakeMs > 0 ? `listening (the mic needed ${wakeMs} ms to start)` : "listening");
  if (wakeMs > 0) console.info(`[mic] live after ${wakeMs} ms`);
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
  if (await sendToBrain({ type: "transcribe", id, audio })) return;
  const line = pendingTranscripts.get(id);
  pendingTranscripts.delete(id);
  if (line) transcript.remove(line);
  setStatus("brain fault: the recording was not sent");
  restState();
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
  // A letter shortcut must not also type its letter into a field that it focuses.
  const isShortcut = !e.metaKey && !e.ctrlKey && !e.altKey && [",", "l", "s", "f", "t"].includes(e.key);
  if (isShortcut) e.preventDefault();
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const openOverlayView = overlays.find((o) => o.isOpen);
  if (e.key === "Escape" && openOverlayView) {
    closeOverlay(openOverlayView);
  } else if (e.key === ",") {
    toggleSettings();
  } else if (e.key === "l") {
    toggleLog();
  } else if (e.key === "Escape") {
    stopSpeech();
    void sendToBrain({ type: "interrupt" });
  } else if (e.key === "s") {
    togglePanel();
  } else if (e.key === "f") {
    const faces = allFaces();
    const index = faces.findIndex((f) => f.id === head.getFace().id);
    const face = faces[(index + 1) % faces.length];
    updateConfig({ ...config, face: face.id });
    setStatus(`face: ${face.name} (${characterFor(config).behavior.name})`);
  } else if (e.key === "t") {
    const pinned = !config.look.transcriptPinned;
    updateConfig({ ...config, look: { ...config.look, transcriptPinned: pinned } });
    setStatus(pinned ? "transcript: always show" : `transcript: hide after ${config.look.transcriptHideSeconds} s`);
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

function hidePanel(): void {
  clearTimeout(panelFadeTimer);
  panel.hidden = true;
  panel.classList.remove("fading");
  // Give the keys back to the head, so that Space is push-to-talk.
  if (panel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
}

function togglePanel(): void {
  panel.hidden = !panel.hidden;
  panel.classList.remove("fading");
  if (!panel.hidden) {
    (projectInput.value ? textInput : projectInput).focus();
    armPanelFade();
  }
}

// The panel fades away after some time with no activity. S shows it again.
let panelIdleMs = 5000;
const PANEL_FADE_MS = 400;
let panelFadeTimer: number | undefined;

function armPanelFade(): void {
  clearTimeout(panelFadeTimer);
  panel.classList.remove("fading");
  if (panel.hidden) return;
  panelFadeTimer = window.setTimeout(fadePanel, panelIdleMs);
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

const recentProjects = $<HTMLDataListElement>("recent-projects");

$("project-browse").addEventListener("click", async () => {
  if (!isTauri()) return;
  const path = await invoke<string | null>("pick_folder").catch((e) => {
    setStatus(`folder chooser fault: ${String(e).slice(0, 120)}`);
    return null;
  });
  if (!path) return;
  projectInput.value = path;
  $("project-set").click();
});

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
  } else if (e.key === "Escape") {
    hidePanel();
  }
});
$("panel-close").addEventListener("click", () => hidePanel());

panel.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  player.unlock();
  const line = transcript.add("user", text);
  logView.add("user", text);
  textInput.value = "";
  void sendToBrain({ type: "user_text", text }).then((sent) => {
    if (sent) return;
    transcript.remove(line);
    if (!textInput.value) textInput.value = text;
    setStatus("brain fault: the message was not sent");
    logView.add("fault", "The message was not sent.");
  });
});
textInput.addEventListener("keydown", (e) => {
  // Enter sends. Shift+Enter makes a new line. Escape closes the panel.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    panel.requestSubmit();
  } else if (e.key === "Escape") {
    hidePanel();
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
$("open-settings").addEventListener("click", () => toggleSettings());
$("open-log").addEventListener("click", () => toggleLog());

// ---------------------------------------------------------------- configuration

/** The brain owns the config. In the browser preview, it lives here only. */
let config: Config = parseConfig(urlFace ? { face: urlFace } : undefined);
let windowSizeRestored = false;
/** The brain can send its default config, with no saved size, before it loads the settings. */
let brainConfigSeen = false;

const settingsView = new SettingsView($("settings"), allFaces(), {
  change: (next) => updateConfig(next),
  testVoice: (text) => {
    player.unlock();
    player.stop();
    void sendToBrain({ type: "speak", id: nextSpeechId++, text });
  },
  refreshVoices: () => void sendToBrain({ type: "list_voices" }),
  refreshMcp: () => void sendToBrain({ type: "list_mcp" }),
  installFace: () => void installFace(),
  removeFace: (faceId) => void removeFace(faceId),
  installFaceUrl: (url, sha256) =>
    void runInstall(() => invoke<InstallOutcome>("face_install_url", { url, sha256 })),
  loadCatalog: () => void loadCatalog(),
  installCatalogFace: (id) =>
    void runInstall(() =>
      invoke<InstallOutcome>("face_install_catalog", { url: config.faces.catalogUrl, key: config.faces.catalogKey, id }),
    ),
  confirmFace: (accept) => {
    const question = faceQuestion;
    if (!question) return;
    void runInstall(() =>
      invoke<InstallOutcome | null>("face_confirm", { accept, id: question.id, sha256: question.new.sha256 }),
    );
  },
  close: () => closeOverlay(settingsView),
});

const logView = new LogView($("log"), {
  resetCost: () => void sendToBrain({ type: "reset_cost" }),
  close: () => closeOverlay(logView),
});

// ---------------------------------------------------------------- face packages

void loadInstalledFaces();

/** The package ids of the last load, to skip a load when nothing changed. */
let loadedFaceIds: string | null = null;

/**
 * Load the installed face packages. A bad package is skipped and named in the settings.
 * With `ifChanged`, load only if the list of package files changed.
 */
async function loadInstalledFaces(ifChanged = false): Promise<void> {
  if (!isTauri()) return;
  let ids: string[];
  try {
    const installed = await invoke<InstalledPackage[]>("face_list");
    settingsView.setInstalled(installed);
    ids = installed.map((p) => p.id);
  } catch (err) {
    settingsView.setFaceNote(`Face packages: ${String(err)}`);
    return;
  }
  if (ifChanged && ids.join(",") === loadedFaceIds) return;
  loadedFaceIds = ids.join(",");
  const faces: Face[] = [];
  const faults: string[] = [];
  for (const id of ids) {
    try {
      const bytes = await invoke<ArrayBuffer>("face_read", { id });
      faces.push((await loadFacePackage(bytes)).face);
    } catch (err) {
      faults.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const old = allFaces().filter((f) => f.model);
  setInstalledFaces(faces);
  for (const f of old) {
    f.model?.geometry.dispose();
    f.model?.paint?.dispose();
  }
  for (const fault of faults) logView.add("fault", `Face package ${fault}`);
  settingsView.setFaces(allFaces());
  settingsView.setFaceNote(faults.length > 0 ? `${faults.length} face package(s) could not load. Details: L` : "");
  // The saved face can be a package face that was not loaded before.
  const face = faceById(config.face);
  if (head.getFace().id !== face.id || old.some((f) => f.id === face.id)) head.setFace(face);
  settingsView.show(config);
}

async function installFace(): Promise<void> {
  await runInstall(() => invoke<InstallOutcome | null>("face_install"));
}

/** The replace question that the settings show, or null. */
let faceQuestion: Extract<InstallOutcome, { kind: "confirm" }> | null = null;

/** Run 1 install command and show its result. A null result means that the user cancelled. */
async function runInstall(install: () => Promise<InstallOutcome | null>): Promise<void> {
  // Each install replaces the package that waits in the shell, so an open question is void.
  faceQuestion = null;
  settingsView.showFaceConfirm(null);
  settingsView.setFaceNote("installing");
  let outcome: InstallOutcome | null;
  try {
    outcome = await install();
  } catch (err) {
    settingsView.setFaceNote(`Install failed: ${String(err)}`);
    return;
  }
  settingsView.setFaceNote("");
  if (!outcome) return;
  if (outcome.kind === "confirm") {
    faceQuestion = outcome;
    settingsView.showFaceConfirm(outcome);
    return;
  }
  if (outcome.kind === "unchanged") {
    setStatus(`face ${outcome.id} is already installed`);
    return;
  }
  await loadInstalledFaces();
  const faceId = packageFaceId(outcome.id);
  if (!allFaces().some((f) => f.id === faceId)) {
    setStatus(`face ${outcome.id} is installed, but it could not load`);
    return;
  }
  updateConfig({ ...config, face: faceId });
  setStatus(`face installed: ${faceById(faceId).name}`);
}

async function loadCatalog(): Promise<void> {
  const { catalogUrl, catalogKey } = config.faces;
  if (!catalogUrl) {
    settingsView.setCatalog(null, "no catalog URL");
    return;
  }
  try {
    settingsView.setCatalog(await invoke<FaceCatalog>("face_catalog", { url: catalogUrl, key: catalogKey }));
  } catch (err) {
    settingsView.setCatalog(null, String(err));
  }
}

async function removeFace(faceId: string): Promise<void> {
  if (!isPackageFaceId(faceId)) return;
  const name = faceById(faceId).name;
  try {
    await invoke("face_remove", { id: faceId.slice(PACKAGE_PREFIX.length) });
  } catch (err) {
    settingsView.setFaceNote(`Remove failed: ${String(err)}`);
    return;
  }
  if (config.face === faceId) updateConfig({ ...config, face: "host" });
  await loadInstalledFaces();
  setStatus(`face removed: ${name}`);
}

// ---------------------------------------------------------------- overlays

/** A full-window view: the settings or the log. Only 1 is open at a time. */
type Overlay = { readonly isOpen: boolean; open(): void; close(): void };
const overlays: Overlay[] = [settingsView, logView];
const anyOverlayOpen = () => overlays.some((o) => o.isOpen);

function toggleSettings(): void {
  if (settingsView.isOpen) closeOverlay(settingsView);
  else openSettings();
}

/** Open the settings. A face that was installed with the face tools shows at once. */
function openSettings(): void {
  openOverlay(settingsView);
  void loadInstalledFaces(true);
}

function toggleLog(): void {
  if (logView.isOpen) closeOverlay(logView);
  else openOverlay(logView);
}

// At a screen border, a part of the window can be off the screen. An overlay fills
// the window, so its Close button can be off the screen too. While an overlay is
// open, the window moves (and if necessary shrinks) into the work area of its monitor.
let rectBeforeSettings: Rect | null = null;
let rectForSettings: Rect | null = null;
let windowMove: Promise<void> = Promise.resolve();

function openOverlay(view: Overlay): void {
  for (const other of overlays) if (other !== view) other.close();
  view.open();
  if (isTauri()) windowMove = windowMove.then(fitWindowForSettings).catch((e) => console.warn("overlay fit", e));
}

function closeOverlay(view: Overlay): void {
  view.close();
  if (isTauri()) windowMove = windowMove.then(restoreWindowAfterSettings).catch((e) => console.warn("overlay restore", e));
}

async function windowRect(): Promise<Rect> {
  const win = getCurrentWindow();
  const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
  return { x: pos.x, y: pos.y, width: size.width, height: size.height };
}

async function fitWindowForSettings(): Promise<void> {
  if (!anyOverlayOpen() || rectBeforeSettings) return;
  const win = getCurrentWindow();
  const rect = await windowRect();
  const monitor =
    (await currentMonitor()) ??
    (await monitorFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) ??
    (await primaryMonitor());
  if (!monitor) return;
  const area = monitor.workArea;
  const fit = fitInto(rect, { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height });
  if (sameRect(fit, rect)) return;
  rectBeforeSettings = rect;
  rectForSettings = fit;
  if (fit.width !== rect.width || fit.height !== rect.height) await win.setSize(new PhysicalSize(fit.width, fit.height));
  await win.setPosition(new PhysicalPosition(fit.x, fit.y));
}

/** Put the window back, but not if the user moved or resized it while the settings were open. */
async function restoreWindowAfterSettings(): Promise<void> {
  const rect = rectBeforeSettings;
  if (!rect || anyOverlayOpen()) return;
  const moved = !rectForSettings || !sameRect(await windowRect(), rectForSettings);
  rectBeforeSettings = rectForSettings = null;
  if (moved) {
    saveWindowSize();
    return;
  }
  const win = getCurrentWindow();
  await win.setPosition(new PhysicalPosition(rect.x, rect.y));
  await win.setSize(new PhysicalSize(rect.width, rect.height));
}

/** Use a config in the window: face, glitch, backdrop, transcript, panel and size. */
function applyConfig(next: Config, fromBrain = false): void {
  config = next;
  const face = faceById(next.face);
  if (head.getFace().id !== face.id) head.setFace(face);
  player.setGlitchLevel(characterFor(next).voice.glitch / 100);
  head.setBackdrop(next.look.backdrop);
  transcript.configure(next.look.transcriptPinned, next.look.transcriptHideSeconds);
  panelIdleMs = next.look.panelHideSeconds * 1000;
  settingsView.show(next);
  logView.setName(characterFor(next).behavior.name);
  // Restore the saved window size once, from the first brain config that has a size.
  if (fromBrain) brainConfigSeen = true;
  const { windowWidth: w, windowHeight: h } = next.look;
  if (fromBrain && !windowSizeRestored && w > 0 && h > 0) {
    windowSizeRestored = true;
    if (w !== window.innerWidth || h !== window.innerHeight) {
      void getCurrentWindow().setSize(new LogicalSize(w, h));
    }
  }
}

/** Change the config: use it now and send it to the brain, which saves it. */
function updateConfig(next: Config): void {
  applyConfig(next);
  if (isTauri()) void sendToBrain({ type: "set_config", config: next });
}

applyConfig(config);
// Browser preview: ?settings opens the settings view.
if (new URLSearchParams(location.search).has("settings")) openOverlay(settingsView);
if (new URLSearchParams(location.search).has("log")) openOverlay(logView);

// ---------------------------------------------------------------- window size

$("resize-grip").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (isTauri()) void getCurrentWindow().startResizeDragging("SouthEast");
});

// Save the size when the user stops resizing.
let resizeTimer: number | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  // A shrink for the settings view is not a size to keep.
  resizeTimer = window.setTimeout(() => rectBeforeSettings || saveWindowSize(), 800);
});

function saveWindowSize(): void {
  if (!brainConfigSeen) return;
  // A size that the user chose replaces the saved size.
  windowSizeRestored = true;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w === config.look.windowWidth && h === config.look.windowHeight) return;
  updateConfig({ ...config, look: { ...config.look, windowWidth: w, windowHeight: h } });
}

// ---------------------------------------------------------------- dev keys

// 1-5: state   G: glitch   B: backdrop (saved)
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
      updateConfig({ ...config, look: { ...config.look, backdrop: !config.look.backdrop } });
    }
  });
}
