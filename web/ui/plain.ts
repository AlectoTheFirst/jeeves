// Turns the agent's Markdown into plain text for the small transcript lines.
// The full Markdown stays in the Claude Code session log.

export function toPlainText(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*```/.test(line)) // code fence lines
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "") // headings
        .replace(/^(\s*)[*+]\s+/, "$1- ") // list marks
        .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2") // bold
        .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, "$1$2") // italic
        .replace(/`([^`]+)`/g, "$1") // inline code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"), // links
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
