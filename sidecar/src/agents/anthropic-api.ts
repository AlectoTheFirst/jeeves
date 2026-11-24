import Anthropic from "@anthropic-ai/sdk";
import type { AgentHost, AgentMessage, BrainAgent } from "./types.ts";
import { isProjectRead } from "./scope.ts";
import { VOICE_PROMPT } from "./shared.ts";
import { executeTool, TOOLS } from "./tools.ts";

export type AnthropicApiOptions = {
  model: string;
  persona: string;
};

/** The characters of a tool result that the history keeps. */
const MAX_TOOL_RESULT = 50_000;
/** The size of the history in JSON characters, about 100k tokens. */
export const MAX_HISTORY_CHARS = 400_000;
const SHORTENED_RESULT = "(This tool result was removed to keep the conversation short.)";

function historySize(messages: Anthropic.MessageParam[]): number {
  return messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
}

/** True for a user message with the user's text, which starts a turn. */
function isTurnStart(m: Anthropic.MessageParam): boolean {
  return (
    m.role === "user" &&
    (typeof m.content === "string" || !m.content.some((b) => b.type === "tool_result"))
  );
}

/**
 * The history cut to at most `maxChars` JSON characters. The oldest whole turns go first,
 * so a tool_use stays with its tool_result and the history starts with a user message.
 * The last turn stays. If it is still too long, its oldest tool results are replaced
 * with a short text.
 */
export function trimHistory(
  messages: Anthropic.MessageParam[],
  maxChars: number,
): Anthropic.MessageParam[] {
  const sizes = messages.map((m) => JSON.stringify(m.content).length);
  let total = sizes.reduce((a, b) => a + b, 0);
  let start = 0;
  while (total > maxChars) {
    let next = start + 1;
    while (next < messages.length && !isTurnStart(messages[next])) next++;
    if (next >= messages.length) break;
    for (let i = start; i < next; i++) total -= sizes[i];
    start = next;
  }
  const kept = start === 0 ? messages : messages.slice(start);
  if (total <= maxChars) return kept;

  return kept.map((m) => {
    if (total <= maxChars || m.role !== "user" || typeof m.content === "string") return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (total <= maxChars || b.type !== "tool_result") return b;
      const size = JSON.stringify(b.content ?? "").length;
      if (size <= SHORTENED_RESULT.length + 2) return b;
      total -= size - (SHORTENED_RESULT.length + 2);
      changed = true;
      return { ...b, content: SHORTENED_RESULT };
    });
    return changed ? ({ ...m, content } as Anthropic.MessageParam) : m;
  });
}

/** A copy of the messages with a cache breakpoint on the last content block. */
function withCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  const end = blocks.length - 1;
  if (end < 0) return messages;
  blocks[end] = { ...blocks[end], cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam;
  return [...messages.slice(0, -1), { ...last, content: blocks } as Anthropic.MessageParam];
}

const CACHED_TOOLS: Anthropic.Tool[] = TOOLS.map((t, i) =>
  i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t,
);

export class AnthropicApiAgent implements BrainAgent {
  private client: Anthropic;
  /** Between turns the history is empty or ends with an assistant message. */
  private messages: Anthropic.MessageParam[] = [];
  /** User messages that wait for the running turn to end. */
  private queued: string[] = [];
  private running = false;
  private closed = false;
  private abortController: AbortController | null = null;
  private processing = false;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheWriteTokens = 0;
  private totalCacheReadTokens = 0;

  constructor(
    readonly cwd: string,
    private host: AgentHost,
    private options: AnthropicApiOptions,
  ) {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.host.onMessage({
      type: "system",
      subtype: "init",
      session_id: `anthropic-${Date.now()}`,
    });
  }

  send(text: string): void {
    if (this.closed) return;
    this.queued.push(text);
    void this.runTurns();
  }

  private systemPrompt(): string {
    const persona = this.options.persona;
    return persona ? `${VOICE_PROMPT}\n\n${persona}` : VOICE_PROMPT;
  }

  /** A closed agent sends nothing to the host. */
  private emit(msg: AgentMessage): void {
    if (!this.closed) this.host.onMessage(msg);
  }

  private emitResult(ok: boolean, result: string, errors: string[] = []): void {
    this.emit({
      type: "result",
      subtype: ok ? "success" : "error",
      is_error: !ok,
      result,
      errors,
      total_cost_usd: this.estimateCost(),
      num_turns: 1,
    });
  }

  /** Runs turns until no user message waits. Messages that wait are joined into 1 turn. */
  private async runTurns(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queued.length > 0 && !this.closed) {
        await this.runTurn(this.queued.splice(0).join("\n\n"));
      }
    } finally {
      this.processing = false;
    }
  }

  private async runTurn(text: string): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    const userMessage: Anthropic.MessageParam = { role: "user", content: text };
    this.messages.push(userMessage);

    try {
      const finalText = await this.runConversationLoop(controller.signal);
      this.emitResult(true, finalText);
    } catch (err) {
      if (controller.signal.aborted) {
        // The roles must alternate, so a stopped turn ends with an assistant message.
        if (this.messages[this.messages.length - 1]?.role === "user") {
          this.messages.push({ role: "assistant", content: "(The user stopped this turn.)" });
        }
        this.emitResult(true, "Stopped.");
      } else {
        // The failed turn is removed from the history. The trim keeps the last turn, so the message is in it.
        const start = this.messages.indexOf(userMessage);
        if (start >= 0) this.messages.length = start;
        const msg = err instanceof Error ? err.message : String(err);
        this.emitResult(false, "", [msg]);
      }
    }
  }

  private async runConversationLoop(signal: AbortSignal): Promise<string> {
    const MAX_ITERATIONS = 10;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      signal.throwIfAborted();
      if (historySize(this.messages) > MAX_HISTORY_CHARS) {
        // A trim changes the cached prefix, so it cuts to 3/4 of the limit to trim less often.
        this.messages = trimHistory(this.messages, (MAX_HISTORY_CHARS * 3) / 4);
      }
      const response = await this.client.messages.create(
        {
          model: this.options.model,
          max_tokens: 4096,
          system: [
            { type: "text", text: this.systemPrompt(), cache_control: { type: "ephemeral" } },
          ],
          messages: withCacheBreakpoint(this.messages),
          tools: CACHED_TOOLS,
        },
        { signal },
      );

      if (response.usage) {
        this.totalInputTokens += response.usage.input_tokens;
        this.totalOutputTokens += response.usage.output_tokens;
        this.totalCacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
        this.totalCacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      }

      const contentBlocks = response.content;
      const toolUseBlocks = contentBlocks.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      // Emit assistant message for UI
      this.emit({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          content: contentBlocks.map((b) =>
            b.type === "text"
              ? { type: "text", text: b.text }
              : {
                  type: "tool_use",
                  name: (b as Anthropic.ToolUseBlock).name,
                  input: (b as Anthropic.ToolUseBlock).input as Record<string, unknown>,
                  id: (b as Anthropic.ToolUseBlock).id,
                },
          ),
        },
      });

      if (toolUseBlocks.length === 0) {
        const textBlocks = contentBlocks.filter(
          (b): b is Anthropic.TextBlock => b.type === "text",
        );
        const finalText = textBlocks.map((b) => b.text).join("");
        this.messages.push({
          role: "assistant",
          content: contentBlocks as any,
        });
        return finalText;
      }

      // Execute tools and build results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tool of toolUseBlocks) {
        signal.throwIfAborted();
        const allowed = isProjectRead(tool.name, tool.input as Record<string, unknown>, this.cwd);
        let approved = allowed;
        if (!allowed) {
          approved = await this.host.askPermission({
            tool: tool.name,
            input: tool.input as Record<string, unknown>,
            signal,
          });
          signal.throwIfAborted();
        }

        if (!approved) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tool.id,
            content: "The user denied permission for this action.",
            is_error: true,
          });
          continue;
        }

        const result = await executeTool(
          tool.name,
          tool.input as Record<string, unknown>,
          this.cwd,
          signal,
        );
        signal.throwIfAborted();
        const content =
          result.content.length > MAX_TOOL_RESULT
            ? `${result.content.slice(0, MAX_TOOL_RESULT)}\n(The output was cut at ${MAX_TOOL_RESULT} characters.)`
            : result.content;
        toolResults.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content,
          is_error: result.isError,
        });
      }

      this.messages.push({
        role: "assistant",
        content: contentBlocks as any,
      });
      this.messages.push({
        role: "user",
        content: toolResults as any,
      });
    }

    const stopped = "Reached the maximum number of tool iterations.";
    this.messages.push({ role: "assistant", content: stopped });
    return stopped;
  }

  private estimateCost(): number {
    const model = this.options.model;
    let inputRate = 3; // $ per million tokens
    let outputRate = 15;

    if (model.includes("opus")) {
      inputRate = 15;
      outputRate = 75;
    } else if (model.includes("haiku")) {
      inputRate = 0.8;
      outputRate = 4;
    }

    // A cache write costs 1.25 times the input rate and a cache read 0.1 times.
    return (
      ((this.totalInputTokens + this.totalCacheWriteTokens * 1.25 + this.totalCacheReadTokens * 0.1) *
        inputRate +
        this.totalOutputTokens * outputRate) /
      1_000_000
    );
  }

  async mcpStatus(): Promise<any[]> {
    return [];
  }

  async interrupt(): Promise<void> {
    this.queued = [];
    this.abortController?.abort();
  }

  close(): void {
    this.closed = true;
    this.queued = [];
    this.running = false;
    this.abortController?.abort();
  }
}
