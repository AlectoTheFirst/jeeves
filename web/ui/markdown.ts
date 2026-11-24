// A small Markdown parser for the log view. It knows only what agent replies use:
// code blocks, headings, lists, paragraphs, and inline code, bold, italic and links.
// The output is data. The log view builds DOM nodes from it, so no HTML is parsed.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "para"; inlines: Inline[] };

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)(.+?)\*(?![\w*])/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ kind: "bold", text: m[2] ?? m[3] });
    else if (m[4] !== undefined) out.push({ kind: "link", text: m[4], href: m[5] });
    else out.push({ kind: "italic", text: m[6] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d+[.)]\s+(.*)$/;

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "para", inlines: parseInline(para.join(" ")) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      // A missing closing fence: the code block runs to the end.
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) code.push(lines[i]);
      blocks.push({ kind: "code", lang: fence[2], text: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, inlines: parseInline(heading[2].trim()) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const prev = blocks.at(-1);
      const item = parseInline((bullet ?? numbered)![1]);
      if (prev?.kind === "list" && prev.ordered === ordered) prev.items.push(item);
      else blocks.push({ kind: "list", ordered, items: [item] });
      continue;
    }
    if (!line.trim()) {
      flush();
      // A blank line ends a list.
      if (blocks.at(-1)?.kind === "list") blocks.push({ kind: "para", inlines: [] });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks.filter((b) => b.kind !== "para" || b.inlines.length > 0);
}
