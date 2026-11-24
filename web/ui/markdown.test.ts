import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown.ts";

describe("parseInline", () => {
  it("finds code, bold, italic and links", () => {
    expect(parseInline("Run `npm test` and **look** at *this* [doc](https://x.io).")).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: " and " },
      { kind: "bold", text: "look" },
      { kind: "text", text: " at " },
      { kind: "italic", text: "this" },
      { kind: "text", text: " " },
      { kind: "link", text: "doc", href: "https://x.io" },
      { kind: "text", text: "." },
    ]);
  });

  it("keeps a lone star and stars in code as text", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ kind: "text", text: "2 * 3 = 6" }]);
    expect(parseInline("`a*b*c`")).toEqual([{ kind: "code", text: "a*b*c" }]);
  });
});

describe("parseMarkdown", () => {
  it("splits headings, lists, code and paragraphs", () => {
    const md = ["## Result", "", "The tests pass.", "Two lines.", "", "- one", "- two", "", "1. first", "", "```ts", "const a = 1;", "", "a++;", "```", "End."].join("\n");
    expect(parseMarkdown(md)).toEqual([
      { kind: "heading", level: 2, inlines: [{ kind: "text", text: "Result" }] },
      { kind: "para", inlines: [{ kind: "text", text: "The tests pass. Two lines." }] },
      { kind: "list", ordered: false, items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]] },
      { kind: "list", ordered: true, items: [[{ kind: "text", text: "first" }]] },
      { kind: "code", lang: "ts", text: "const a = 1;\n\na++;" },
      { kind: "para", inlines: [{ kind: "text", text: "End." }] },
    ]);
  });

  it("runs an open code block to the end", () => {
    expect(parseMarkdown("```\nx\ny")).toEqual([{ kind: "code", lang: "", text: "x\ny" }]);
  });

  it("keeps HTML as text", () => {
    expect(parseMarkdown("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "para", inlines: [{ kind: "text", text: "<img src=x onerror=alert(1)>" }] },
    ]);
  });
});
