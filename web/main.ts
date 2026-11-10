import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { encode, parseFromBrain, type ToBrain } from "../sidecar/src/protocol.ts";
import { HeadScene } from "./scene/head.ts";
import { HEAD_STATES } from "./scene/state.ts";

const status = document.getElementById("status")!;
const canvas = document.getElementById("scene") as HTMLCanvasElement;

const head = new HeadScene(canvas);
head.start();

function setStatus(text: string): void {
  status.textContent = text;
}

async function sendToBrain(msg: ToBrain): Promise<void> {
  await invoke("brain_send", { line: encode(msg) });
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
    }
  });
  // The brain can be ready before the listener exists. Ask for a pong directly too.
  await sendToBrain({ type: "ping", id: Date.now() });
}

connectBrain().catch((err) => setStatus(`brain fault: ${String(err)}`));

// Development keys. Milestone 3 replaces the talk demo with real lip-sync.
//   1-5: state   G: glitch   B: backdrop   T: talk demo
if (import.meta.env.DEV) {
  let talkTimer: number | undefined;
  let fakeLevel = 0;

  const stopTalk = () => {
    window.clearInterval(talkTimer);
    talkTimer = undefined;
    head.setMouth({ jaw: 0, wide: 0, round: 0 });
  };

  window.addEventListener("keydown", (e) => {
    const index = Number(e.key) - 1;
    if (index >= 0 && index < HEAD_STATES.length) {
      head.setState(HEAD_STATES[index]);
      setStatus(`state: ${HEAD_STATES[index]}`);
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

  // A fake mic level so that the listening state has something to show.
  window.setInterval(() => {
    fakeLevel = Math.max(0, Math.min(1, fakeLevel + (Math.random() - 0.5) * 0.4));
    head.setListenLevel(fakeLevel);
  }, 80);
}
