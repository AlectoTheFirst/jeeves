// 1 Claude Code session, driven by the Agent SDK with streaming input, so that it
// stays open for many turns. The host (the brain) answers permission prompts and
// questions through callbacks.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  query,
  type CanUseTool,
  type McpServerStatus,
  type PermissionResult,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentHost, AgentMessage, BrainAgent } from "./types.ts";
import { isProjectRead } from "./scope.ts";
import { VOICE_PROMPT } from "./shared.ts";

/** Where the Claude Code CLI is. The SDK's bundled binary cannot be found in a Bun single-file build. */
export function findClaudeCli(): string | undefined {
  const fromEnv = process.env.JEEVES_CLAUDE_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const local = join(homedir(), ".local", "bin", "claude");
  return existsSync(local) ? local : undefined;
}

/**
 * The environment for Claude Code: the brain's own, without secrets that the agent
 * does not need. Its Bash tool can read every variable. ANTHROPIC_API_KEY stays: it
 * is set only when the user stored 1, and Claude Code needs it then.
 */
function agentEnv(): Record<string, string | undefined> {
  const { ELEVENLABS_API_KEY: _voiceKey, ...env } = process.env;
  return env;
}

/** A queue that the SDK reads as its prompt stream. */
class InputQueue implements AsyncIterable<any> {
  private items: any[] = [];
  private waiting: ((r: IteratorResult<any>) => void) | null = null;
  private closed = false;

  push(item: any): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<any> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

export type ClaudeCodeOptions = {
  model: string;
  persona: string;
  mcpServers: Record<string, any>;
  strictMcpConfig: boolean;
  trustedTools: string[];
};

function sdkMessageToAgentMessage(msg: SDKMessage): AgentMessage | null {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        return { type: "system", subtype: "init", session_id: msg.session_id };
      }
      return null;
    case "assistant": {
      const content: Extract<AgentMessage, { type: "assistant" }>["message"]["content"] = [];
      for (const block of msg.message.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          content.push({
            type: "tool_use",
            name: block.name,
            input: block.input as Record<string, unknown>,
            id: block.id,
          });
        }
      }
      return {
        type: "assistant",
        parent_tool_use_id: msg.parent_tool_use_id ?? null,
        message: { role: "assistant", content },
      };
    }
    case "result":
      return {
        type: "result",
        subtype: msg.subtype === "success" ? "success" : "error",
        is_error: msg.is_error,
        result: msg.subtype === "success" ? msg.result : "",
        // Keep the SDK fault kind, for example error_max_turns, if the SDK gives no text.
        errors: msg.subtype !== "success" && msg.errors.length > 0 ? msg.errors : msg.subtype === "success" ? [] : [msg.subtype],
        total_cost_usd: msg.total_cost_usd,
        num_turns: msg.num_turns,
      };
    default:
      return null;
  }
}

export class ClaudeCodeAgent implements BrainAgent {
  private input = new InputQueue();
  private q: Query | null = null;
  private running = false;

  constructor(
    readonly cwd: string,
    private host: AgentHost,
    private resumeId?: string,
    private options: ClaudeCodeOptions = {
      model: "claude-opus-5-5",
      persona: "",
      mcpServers: {},
      strictMcpConfig: false,
      trustedTools: [],
    },
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const canUseTool: CanUseTool = async (tool, input, options): Promise<PermissionResult> => {
      if (tool === "AskUserQuestion") {
        const answers = await this.host.askQuestions(input, options.signal);
        return answers
          ? { behavior: "allow", updatedInput: { ...input, answers } }
          : { behavior: "deny", message: "The user did not answer the question." };
      }
      // Reads in the project folder need no question. A read outside it gets a card.
      if (isProjectRead(tool, input, this.cwd)) return { behavior: "allow" };
      const allowed = await this.host.askPermission({
        tool,
        input,
        title: options.title,
        description: options.description,
        signal: options.signal,
      });
      return allowed ? { behavior: "allow" } : { behavior: "deny", message: "The user said no to this action." };
    };

    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.cwd,
        model: this.options.model,
        // No read tools here: an allowedTools entry approves a tool before canUseTool
        // can check the path.
        allowedTools: this.options.trustedTools,
        mcpServers: this.options.mcpServers,
        strictMcpConfig: this.options.strictMcpConfig,
        canUseTool,
        resume: this.resumeId,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: this.options.persona ? `${VOICE_PROMPT}\n\n${this.options.persona}` : VOICE_PROMPT,
        },
        pathToClaudeCodeExecutable: findClaudeCli(),
        env: agentEnv(),
      },
    });

    void (async () => {
      try {
        for await (const msg of this.q!) {
          const agentMsg = sdkMessageToAgentMessage(msg);
          if (agentMsg) this.host.onMessage(agentMsg);
        }
      } catch (err) {
        this.host.onFault(err);
      } finally {
        this.running = false;
      }
    })();
  }

  send(text: string): void {
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    });
  }

  async mcpStatus(): Promise<McpServerStatus[]> {
    if (!this.q) return [];
    return this.q.mcpServerStatus();
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt();
  }

  close(): void {
    this.input.close();
    this.q?.close();
    this.running = false;
  }
}
