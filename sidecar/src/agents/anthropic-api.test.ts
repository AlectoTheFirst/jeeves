import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { AnthropicApiAgent, trimHistory } from "./anthropic-api.ts";
import type { AgentHost, AgentMessage } from "./types.ts";

type Reply = { content: Array<Record<string, unknown>> } | Error;

function setup(replies: Reply[], askPermission: AgentHost["askPermission"] = async () => false) {
  const messages: AgentMessage[] = [];
  const host: AgentHost = {
    onMessage: (m) => messages.push(m),
    onFault: vi.fn(),
    askPermission,
    askQuestions: async () => null,
  };
  const agent = new AnthropicApiAgent("/tmp", host, { model: "claude-test", persona: "" });
  const requests: Anthropic.MessageParam[][] = [];
  const create = vi.fn(async (params: { messages: Anthropic.MessageParam[] }, opts: { signal: AbortSignal }) => {
    requests.push(structuredClone(params.messages));
    await new Promise((r) => setTimeout(r, 10));
    opts.signal.throwIfAborted();
    const reply = replies.shift();
    if (!reply || reply instanceof Error) throw reply ?? new Error("no reply");
    return { ...reply, usage: { input_tokens: 10, output_tokens: 10 } };
  });
  (agent as unknown as { client: unknown }).client = { messages: { create } };
  agent.start();
  const results = () => messages.filter((m) => m.type === "result");
  return { agent, host, messages, requests, results };
}

const text = (t: string) => ({ content: [{ type: "text", text: t }] });

describe("AnthropicApiAgent", () => {
  it("answers a message that arrives while a turn runs", async () => {
    const { agent, requests, results } = setup([text("one"), text("two")]);
    agent.send("first");
    agent.send("second");
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    expect(results().map((r) => r.type === "result" && r.result)).toEqual(["one", "two"]);
    expect(requests[1].map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("reports an API error as a result only and keeps the session usable", async () => {
    const { agent, host, requests, results } = setup([new Error("overloaded"), text("ok")]);
    agent.send("first");
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]).toMatchObject({ subtype: "error", errors: ["overloaded"] });
    expect(host.onFault).not.toHaveBeenCalled();
    agent.send("again");
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    expect(requests[1]).toEqual([{ role: "user", content: [{ type: "text", text: "again", cache_control: { type: "ephemeral" } }] }]);
  });

  it("sends nothing to the host after close", async () => {
    const { agent, messages } = setup([text("late")]);
    agent.send("hello");
    const before = messages.length;
    agent.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(messages.length).toBe(before);
  });

  it("asks for no further tool after a stop", async () => {
    const bash = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { command: "true" } });
    let agentRef: AnthropicApiAgent | null = null;
    const ask = vi.fn(async () => {
      void agentRef!.interrupt();
      return false;
    });
    const { agent, results } = setup([{ content: [bash("t1"), bash("t2")] }], ask);
    agentRef = agent;
    agent.send("run 2 commands");
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(results()[0]).toMatchObject({ subtype: "success", result: "Stopped." });
  });
});

describe("trimHistory", () => {
  const user = (t: string): Anthropic.MessageParam => ({ role: "user", content: t });
  const assistant = (t: string): Anthropic.MessageParam => ({ role: "assistant", content: t });
  const toolUse = (id: string): Anthropic.MessageParam => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name: "Read", input: {} }],
  });
  const toolResult = (id: string, size: number): Anthropic.MessageParam => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(size) }],
  });

  it("keeps a history under the limit", () => {
    const h = [user("a"), assistant("b")];
    expect(trimHistory(h, 1000)).toBe(h);
  });

  it("drops the oldest whole turns with their tool results", () => {
    const h = [user("q1"), toolUse("t1"), toolResult("t1", 500), assistant("a1"), user("q2"), assistant("a2"), user("q3")];
    expect(trimHistory(h, 300)).toEqual([user("q2"), assistant("a2"), user("q3")]);
  });

  it("shortens tool results of the last turn when it alone is too long", () => {
    const h = [user("q1"), toolUse("t1"), toolResult("t1", 5000), toolUse("t2"), toolResult("t2", 100)];
    const out = trimHistory(h, 1000);
    expect(out).toHaveLength(5);
    const first = out[2].content as Anthropic.ToolResultBlockParam[];
    expect(String(first[0].content).length).toBeLessThan(100);
    expect(out[4]).toBe(h[4]);
  });
});
