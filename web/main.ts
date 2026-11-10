import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { encode, parseFromBrain, type ToBrain } from "../sidecar/src/protocol.ts";
import { MicRecorder } from "./audio/mic.ts";
import { SpeechPlayer } from "./audio/player.ts";
import { HeadScene } from "./scene/head.ts";
import { HEAD_STATES } from "./scene/state.ts";
import { Transcript } from "./ui/transcript.ts";

const status = document.getElementById("status")!;
const canvas = document.getElementById("scene") as HTMLCanvasElement;
const transcript = new Transcript(document.getElementById("transcript")!);

const head = new HeadScene(canvas);
head.start();

const player = new SpeechPlayer({
  onStart: () => head.setState("speaking"),
  onEnd: () => {
    head.setMouth({ jaw: 0, wide: 0, round: 0 });
    head.setState("idle");
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

function setStatus(text: string): void {
  status.textContent = text;
}

async function sendToBrain(msg: ToBrain): Promise<void> {
  await invoke("brain_send", { line: encode(msg) });
}

let nextSpeechId = 1;

export async function speak(text: string): Promise<void> {
  player.unlock();
  player.stop();
  head.setState("thinking");
  await sendToBrain({ type: "speak", id: nextSpeechId++, text });
}

async function connectBrain(): Promise<void> {
  if (!isTauri()) {
    setStatus("browser preview: no brain");
    return;
  }
  await listen<string>("brain", (event) => {
    const msg = parseFromBrain(event.payload);
    if (!msg) return;
    switch (msg.type) {
      case "ready":
        setStatus("brain ready");
        void sendToBrain({ type: "ping", id: Date.now() });
        break;
      case "pong":
        setStatus(`brain ok (protocol ${msg.protocol})`);
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
        head.setState("idle");
        setStatus(`voice fault: ${msg.msg.slice(0, 120)}`);
        console.error(`[voice] ${msg.msg}`);
        break;
      case "transcript":
      case "transcript_error": {
        const line = pendingTranscripts.get(msg.id);
        pendingTranscripts.delete(msg.id);
        if (head.getState() === "thinking") head.setState("idle");
        if (msg.type === "transcript_error") {
          if (line) transcript.remove(line);
          setStatus(`hearing fault: ${msg.msg.slice(0, 120)}`);
          console.error(`[stt] ${msg.msg}`);
        } else if (line) {
          if (msg.text) transcript.settle(line, msg.text);
          else transcript.remove(line);
        }
        break;
      }
    }
  });
  // The brain can be ready before the listener exists. Ask for a pong directly too.
  await sendToBrain({ type: "ping", id: Date.now() });
}

connectBrain().catch((err) => setStatus(`brain fault: ${String(err)}`));

// Push-to-talk: hold Space while the window has focus.
// Milestone 5 sends the transcript to Claude Code. Now it only shows it.
const pendingTranscripts = new Map<number, HTMLElement>();
let nextTranscriptId = 1;

const mic = new MicRecorder({
  onLevel: (value) => head.setListenLevel(value),
  onMaxLength: () => void stopListening(),
});

/** True while the push-to-talk key is down. */
let wantListening = false;

async function startListening(): Promise<void> {
  wantListening = true;
  if (mic.isRecording) return;
  player.unlock();
  // Talking over the head stops it, as with a person.
  if (player.active) {
    void sendToBrain({ type: "stop_speech" });
    player.stop();
  }
  try {
    await mic.start();
    // The key came up while the mic opened (for example, during the permission prompt).
    if (!wantListening) {
      mic.stop();
      head.setState("idle");
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
  const audio = await mic.stopAfterTail(() => wantListening);
  // The key went down again during the tail: it is still the same recording.
  if (audio === undefined) return;
  if (!audio) {
    head.setState("idle");
    setStatus("too short");
    return;
  }
  const id = nextTranscriptId++;
  pendingTranscripts.set(id, transcript.add("user", "...", true));
  head.setState("thinking");
  setStatus("transcribing");
  await sendToBrain({ type: "transcribe", id, audio });
}

const isTyping = (e: KeyboardEvent) =>
  e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;

window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || isTyping(e)) return;
  e.preventDefault();
  void startListening();
});
window.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || isTyping(e)) return;
  e.preventDefault();
  void stopListening();
});
// If the window loses focus while the key is down, the keyup never comes.
window.addEventListener("blur", () => void stopListening());

// Development controls.
//   S: speak panel   1-5: state   G: glitch   B: backdrop   T: talk demo
if (import.meta.env.DEV) {
  const panel = document.getElementById("dev-panel") as HTMLFormElement;
  const text = document.getElementById("dev-text") as HTMLTextAreaElement;
  const glitch = document.getElementById("dev-glitch") as HTMLInputElement;
  const glitchValue = document.getElementById("dev-glitch-value")!;

  panel.addEventListener("submit", (e) => {
    e.preventDefault();
    speak(text.value.trim()).catch((err) => setStatus(`speak fault: ${String(err)}`));
  });
  document.getElementById("dev-stop")!.addEventListener("click", () => {
    void sendToBrain({ type: "stop_speech" });
    player.stop();
  });
  glitch.addEventListener("input", () => {
    glitchValue.textContent = glitch.value;
    player.setGlitchLevel(Number(glitch.value) / 100);
  });

  let talkTimer: number | undefined;

  const stopTalk = () => {
    window.clearInterval(talkTimer);
    talkTimer = undefined;
    head.setMouth({ jaw: 0, wide: 0, round: 0 });
  };

  window.addEventListener("keydown", (e) => {
    // Do not treat typing in the panel as commands.
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    const index = Number(e.key) - 1;
    if (index >= 0 && index < HEAD_STATES.length) {
      head.setState(HEAD_STATES[index]);
      setStatus(`state: ${HEAD_STATES[index]}`);
    } else if (e.key === "s") {
      panel.hidden = !panel.hidden;
    } else if (e.key === "g") {
      head.glitch(1, 400);
    } else if (e.key === "b") {
      head.setBackdrop(!head.backdropOn);
    } else if (e.key === "t") {
      if (talkTimer !== undefined) {
        stopTalk();
        head.setState("idle");
        return;
      }
      head.setState("speaking");
      setStatus("state: speaking (demo)");
      talkTimer = window.setInterval(() => {
        // A random syllable shape about 9 times per second, with short closed pauses.
        const closed = Math.random() < 0.2;
        head.setMouth({
          jaw: closed ? 0 : 0.2 + Math.random() * 0.8,
          wide: Math.random() < 0.4 ? Math.random() : 0,
          round: Math.random() < 0.3 ? Math.random() : 0,
        });
        if (Math.random() < 0.05) head.glitch(0.6, 150);
      }, 110);
    }
  });
}
