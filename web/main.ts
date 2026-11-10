import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { encode, parseFromBrain, type ToBrain } from "../sidecar/src/protocol.ts";
import { HeadScene } from "./scene/head.ts";

const status = document.getElementById("status")!;
const canvas = document.getElementById("scene") as HTMLCanvasElement;

new HeadScene(canvas).start();

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
