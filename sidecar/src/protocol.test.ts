import { describe, expect, it } from "vitest";
import { encode, parseFromBrain, parseToBrain, PROTOCOL_VERSION } from "./protocol.ts";

describe("parseToBrain", () => {
  it("parses a ping", () => {
    expect(parseToBrain('{"type":"ping","id":7}')).toEqual({ type: "ping", id: 7 });
  });

  it("rejects bad JSON, arrays, unknown types and wrong field types", () => {
    expect(parseToBrain("not json")).toBeNull();
    expect(parseToBrain("[1,2]")).toBeNull();
    expect(parseToBrain('{"type":"rm"}')).toBeNull();
    expect(parseToBrain('{"type":"ping","id":"7"}')).toBeNull();
  });
});

describe("parseFromBrain", () => {
  it("round-trips every message type", () => {
    const messages = [
      { type: "ready", protocol: PROTOCOL_VERSION },
      { type: "pong", id: 1, protocol: PROTOCOL_VERSION },
      { type: "log", level: "warn", msg: "hello" },
    ] as const;
    for (const msg of messages) expect(parseFromBrain(encode(msg))).toEqual(msg);
  });

  it("round-trips agent messages", () => {
    const messages = [
      { type: "agent_status", state: "busy", project: "/p", msg: "" },
      { type: "permission_request", id: 3, text: "Allow?", detail: "npm test" },
      {
        type: "question",
        id: 4,
        questions: [{ question: "Q?", header: "H", multiSelect: false, options: [{ label: "A", description: "a" }] }],
      },
      { type: "agent_result", ok: true, costUsd: 0.12, turns: 3 },
    ] as const;
    for (const msg of messages) expect(parseFromBrain(encode(msg))).toEqual(msg);
  });

  it("rejects a question with a bad option", () => {
    const bad = { type: "question", id: 1, questions: [{ question: "Q", header: "H", multiSelect: false, options: [{ label: 1 }] }] };
    expect(parseFromBrain(JSON.stringify(bad))).toBeNull();
  });

  it("parses answers to the brain", () => {
    expect(parseToBrain('{"type":"question_answer","id":4,"answers":{"Q?":"A"}}')).toEqual({
      type: "question_answer",
      id: 4,
      answers: { "Q?": "A" },
    });
    expect(parseToBrain('{"type":"question_answer","id":4,"answers":{"Q?":1}}')).toBeNull();
    expect(parseToBrain('{"type":"permission_answer","id":2,"allow":"yes"}')).toBeNull();
  });

  it("rejects a log with an unknown level", () => {
    expect(parseFromBrain('{"type":"log","level":"debug","msg":"x"}')).toBeNull();
  });
});
