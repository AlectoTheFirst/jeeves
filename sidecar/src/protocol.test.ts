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

  it("rejects a log with an unknown level", () => {
    expect(parseFromBrain('{"type":"log","level":"debug","msg":"x"}')).toBeNull();
  });
});
