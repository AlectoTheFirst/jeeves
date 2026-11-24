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

describe("config messages", () => {
  it("round-trips config and voices, and checks set_config", async () => {
    const { DEFAULT_CONFIG } = await import("./config.ts");
    const config = { type: "config", config: DEFAULT_CONFIG, keys: { elevenlabs: true, anthropic: false } } as const;
    expect(parseFromBrain(encode(config))).toEqual(config);
    const voices = { type: "voices", voices: [{ id: "a1", name: "Ann", category: "premade" }], error: "" } as const;
    expect(parseFromBrain(encode(voices))).toEqual(voices);
    const set = parseToBrain(JSON.stringify({ type: "set_config", config: { face: "../x" } }));
    expect(set?.type === "set_config" && set.config.face).toBe("host");
    expect(parseToBrain('{"type":"list_voices"}')).toEqual({ type: "list_voices" });
  });

  it("round-trips the MCP status", () => {
    expect(parseToBrain('{"type":"list_mcp"}')).toEqual({ type: "list_mcp" });
    const status = {
      type: "mcp_status",
      servers: [{ name: "home-assistant", status: "connected", source: "user", error: "", tools: 12 }],
      error: "",
    } as const;
    expect(parseFromBrain(encode(status))).toEqual(status);
    expect(parseFromBrain('{"type":"mcp_status","servers":[{"name":1}],"error":""}')).toBeNull();
  });

  it("round-trips focus, cost and projects", () => {
    expect(parseToBrain('{"type":"focus","focused":false}')).toEqual({ type: "focus", focused: false });
    expect(parseToBrain('{"type":"focus","focused":"no"}')).toBeNull();
    expect(parseToBrain('{"type":"reset_cost"}')).toEqual({ type: "reset_cost" });
    const said = { type: "agent_said", text: "All done.", more: true } as const;
    expect(parseFromBrain(encode(said))).toEqual(said);
    expect(parseFromBrain('{"type":"agent_said","text":"x"}')).toBeNull();
    const cost = { type: "cost", spentUsd: 1.25, budgetUsd: 5, requests: 3, since: 1_700_000_000_000, blocked: false } as const;
    expect(parseFromBrain(encode(cost))).toEqual(cost);
    expect(parseFromBrain('{"type":"cost","spentUsd":"1"}')).toBeNull();
    const projects = { type: "projects", recent: ["/a", "/b"] } as const;
    expect(parseFromBrain(encode(projects))).toEqual(projects);
    expect(parseFromBrain('{"type":"projects","recent":[1]}')).toBeNull();
  });
});
