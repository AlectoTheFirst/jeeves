// What the head says aloud, made from agent output. Pure functions.

/** The marker that the system prompt asks Claude to put before the spoken summary. */
export const SPOKEN_MARKER = "SPOKEN:";

export type SplitReply = { spoken: string; display: string };

/** Remove code blocks, inline code marks, links and markdown signs, for speech. */
export function toSpeakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first `count` sentences of a text. */
export function firstSentences(text: string, count: number): string {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [];
  return sentences.slice(0, count).join("").trim();
}

/**
 * Split a reply into the spoken summary and the text for the panel.
 * If the reply has no SPOKEN line, speak its first 2 sentences.
 */
export function splitReply(reply: string): SplitReply {
  const lines = reply.split("\n");
  const index = lines.findIndex((l) => l.trim().toUpperCase().startsWith(SPOKEN_MARKER));
  if (index >= 0) {
    const spoken = toSpeakable(lines[index].trim().slice(SPOKEN_MARKER.length));
    const display = [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n").trim();
    return { spoken, display };
  }
  return { spoken: firstSentences(toSpeakable(reply), 2), display: reply.trim() };
}

/** Short spoken phrase for a tool that starts. Empty for tools not worth a word. */
export function toolPhrase(tool: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const base = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
  switch (tool) {
    case "Bash": {
      const description = str("description");
      if (description) return `${description}.`;
      const command = str("command").split(/\s+/).slice(0, 3).join(" ");
      return command ? `Running ${command}.` : "Running a command.";
    }
    case "Read":
      return str("file_path") ? `Reading ${base(str("file_path"))}.` : "Reading a file.";
    case "Edit":
    case "Write":
      return str("file_path") ? `Changing ${base(str("file_path"))}.` : "Changing a file.";
    case "Grep":
    case "Glob":
      return "Searching the code.";
    case "WebSearch":
    case "WebFetch":
      return "Looking on the web.";
    case "Agent":
      return "Sending a helper agent.";
    default: {
      // MCP tools: "mcp__<server>__<tool>".
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      if (!mcp) return "";
      const words = (s: string) => s.replace(/[_-]+/g, " ").trim();
      return `Using ${words(mcp[2])} from ${words(mcp[1])}.`;
    }
  }
}

/** The spoken permission question. Uses the SDK's own sentence when it has one. */
export function permissionQuestion(tool: string, input: Record<string, unknown>, title?: string): string {
  // The head speaks as its character, so "Claude wants" becomes "I want".
  if (title) return `${toSpeakable(title).replace(/^Claude( Code)? wants\b/i, "I want")}. Allow?`;
  const phrase = toolPhrase(tool, input).replace(/\.$/, "");
  return phrase ? `I want to do this: ${phrase}. Allow?` : `I want to use ${tool}. Allow?`;
}
