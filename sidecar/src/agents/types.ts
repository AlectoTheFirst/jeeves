export type PermissionAsk = {
  tool: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  signal: AbortSignal;
};

export type AgentHost = {
  onMessage: (msg: AgentMessage) => void;
  onFault: (err: unknown) => void;
  askPermission: (ask: PermissionAsk) => Promise<boolean>;
  /** The answers by question text, or null if the user did not answer. */
  askQuestions: (input: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, string> | null>;
};

export type AgentMessage =
  | { type: "system"; subtype: "init"; session_id: string }
  | {
      type: "assistant";
      parent_tool_use_id: string | null;
      message: {
        role: "assistant";
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; name: string; input: Record<string, unknown>; id: string }
        >;
      };
    }
  | {
      type: "result";
      subtype: "success" | "error";
      is_error: boolean;
      result: string;
      errors: string[];
      total_cost_usd: number;
      num_turns: number;
    };

export interface BrainAgent {
  readonly cwd: string;
  readonly isRunning: boolean;
  start(): void;
  send(text: string): void;
  mcpStatus(): Promise<any[]>;
  interrupt(): Promise<void>;
  close(): void;
}
