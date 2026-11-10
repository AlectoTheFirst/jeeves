// 1 Claude Code session, driven by the Agent SDK with streaming input, so that it
// stays open for many turns. The host (the brain) answers permission prompts and
// questions through callbacks.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { SPOKEN_MARKER } from "./spoken.ts";

export const AGENT_MODEL = "claude-opus-5-5";

/** Read-only tools run without a question. */
const ALLOWED_TOOLS = ["Read", "Glob", "Grep"];

const VOICE_PROMPT = `
# Voice interface (required output format)

You talk to the user through a voice interface: an animated retro TV-computer head
on their desktop. The user speaks to you, and a speech-to-text step writes their words,
so expect small transcription mistakes and ask if a request is unclear.

REQUIRED: the first line of every final answer to the user must start with
"${SPOKEN_MARKER}" followed by 1 to 3 short sentences that the head says aloud.
This rule applies in addition to any output style or writing rules you follow, and it
is never optional, also for short answers. The app removes that line from the screen
and speaks it, so the rest of the answer must still make sense without it.

The spoken line is plain speech: no markdown, no code, no file paths longer than a file
name, no lists. It summarizes the outcome in a playful, witty TV-host tone, but never at
the cost of accuracy. Put all detail, code and lists after that line.

Example first line:
${SPOKEN_MARKER} Found it! Your add function subtracts. One sign to flip and we are back in business.
`.trim();

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

export type PermissionAsk = {
  tool: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  signal: AbortSignal;
};

export type AgentHost = {
  /** Every message from the SDK. */
  onMessage: (msg: SDKMessage) => void;
  /** The session stopped because of a fault (not a normal end). */
  onFault: (err: unknown) => void;
  /** Ask the user. Resolve with the decision. */
  askPermission: (ask: PermissionAsk) => Promise<boolean>;
  /** Ask the user AskUserQuestion questions. Resolve with answers keyed by question text, or null to decline. */
  askQuestions: (input: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, string> | null>;
};

/** A queue that the SDK reads as its prompt stream. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(item: SDKUserMessage): void {
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

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
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

export class AgentSession {
  private input = new InputQueue();
  private q: Query | null = null;
  private running = false;

  constructor(
    readonly cwd: string,
    private host: AgentHost,
    private resumeId?: string,
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
        model: AGENT_MODEL,
        allowedTools: ALLOWED_TOOLS,
        canUseTool,
        resume: this.resumeId,
        systemPrompt: { type: "preset", preset: "claude_code", append: VOICE_PROMPT },
        pathToClaudeCodeExecutable: findClaudeCli(),
        env: agentEnv(),
      },
    });

    void (async () => {
      try {
        for await (const msg of this.q!) this.host.onMessage(msg);
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

  async interrupt(): Promise<void> {
    await this.q?.interrupt();
  }

  close(): void {
    this.input.close();
    this.q?.close();
    this.running = false;
  }
}
