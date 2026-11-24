import Anthropic from "@anthropic-ai/sdk";
import type { AgentHost, AgentMessage, BrainAgent } from "./types.ts";
import { isProjectRead } from "./scope.ts";
import { VOICE_PROMPT } from "./shared.ts";
import { executeTool, TOOLS } from "./tools.ts";

export type AnthropicApiOptions = {
  model: string;
  persona: string;
};

export class AnthropicApiAgent implements BrainAgent {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private running = false;
  private abortController: AbortController | null = null;
  private processing = false;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

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
    this.messages.push({ role: "user", content: text });
    void this.runTurn();
  }

  private systemPrompt(): string {
    const persona = this.options.persona;
    return persona ? `${VOICE_PROMPT}\n\n${persona}` : VOICE_PROMPT;
  }

  private async runTurn(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    this.abortController = new AbortController();

    try {
      const finalText = await this.runConversationLoop();
      this.host.onMessage({
        type: "result",
        subtype: "success",
        is_error: false,
        result: finalText,
        errors: [],
        total_cost_usd: this.estimateCost(),
        num_turns: 1,
      });
    } catch (err) {
      if (this.abortController.signal.aborted) {
        this.host.onMessage({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Stopped.",
          errors: [],
          total_cost_usd: this.estimateCost(),
          num_turns: 1,
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.host.onMessage({
          type: "result",
          subtype: "error",
          is_error: true,
          result: "",
          errors: [msg],
          total_cost_usd: this.estimateCost(),
          num_turns: 1,
        });
        this.host.onFault(err);
      }
    } finally {
      this.processing = false;
    }
  }

  private async runConversationLoop(): Promise<string> {
    const MAX_ITERATIONS = 10;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await this.client.messages.create(
        {
          model: this.options.model,
          max_tokens: 4096,
          system: this.systemPrompt(),
          messages: this.messages,
          tools: TOOLS,
        },
        { signal: this.abortController!.signal },
      );

      if (response.usage) {
        this.totalInputTokens += response.usage.input_tokens;
        this.totalOutputTokens += response.usage.output_tokens;
      }

      const contentBlocks = response.content;
      const toolUseBlocks = contentBlocks.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      // Emit assistant message for UI
      this.host.onMessage({
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
        const allowed = isProjectRead(tool.name, tool.input as Record<string, unknown>, this.cwd);
        let approved = allowed;
        if (!allowed) {
          approved = await this.host.askPermission({
            tool: tool.name,
            input: tool.input as Record<string, unknown>,
            signal: this.abortController!.signal,
          });
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
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: result.content.slice(0, 100_000),
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

    return "Reached the maximum number of tool iterations.";
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

    return (
      (this.totalInputTokens * inputRate +
        this.totalOutputTokens * outputRate) /
      1_000_000
    );
  }

  async mcpStatus(): Promise<any[]> {
    return [];
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
  }

  close(): void {
    this.running = false;
    this.abortController?.abort();
  }
}
