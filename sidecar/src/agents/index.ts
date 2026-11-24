import type { AgentHost, BrainAgent } from "./types.ts";
import { ClaudeCodeAgent } from "./claude-code.ts";
import { AnthropicApiAgent } from "./anthropic-api.ts";

export * from "./types.ts";

export type AgentProvider = "claude-code" | "anthropic-api";

export type CreateAgentOptions = {
  provider: AgentProvider;
  model: string;
  persona: string;
  mcpServers: Record<string, any>;
  strictMcpConfig: boolean;
  trustedTools: string[];
};

export function createAgent(
  cwd: string,
  host: AgentHost,
  resumeId: string | undefined,
  options: CreateAgentOptions,
): BrainAgent {
  if (options.provider === "anthropic-api") {
    return new AnthropicApiAgent(cwd, host, {
      model: options.model,
      persona: options.persona,
    });
  }
  return new ClaudeCodeAgent(cwd, host, resumeId, {
    model: options.model,
    persona: options.persona,
    mcpServers: options.mcpServers,
    strictMcpConfig: options.strictMcpConfig,
    trustedTools: options.trustedTools,
  });
}
