// Jeeves brain: the sidecar process. Milestone 1 only answers pings.
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION, encode, parseToBrain, type FromBrain } from "./protocol.ts";

function send(msg: FromBrain): void {
  process.stdout.write(encode(msg) + "\n");
}

const input = createInterface({ input: process.stdin });

input.on("line", (line) => {
  const msg = parseToBrain(line);
  if (!msg) {
    send({ type: "log", level: "warn", msg: `unknown message: ${line.slice(0, 200)}` });
    return;
  }
  switch (msg.type) {
    case "ping":
      send({ type: "pong", id: msg.id, protocol: PROTOCOL_VERSION });
      break;
  }
});

// The Rust core closes stdin when the app quits. Stop with it.
input.on("close", () => process.exit(0));

send({ type: "ready", protocol: PROTOCOL_VERSION });
