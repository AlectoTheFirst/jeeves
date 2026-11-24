// The log view: a full-window list of the conversation. Agent replies show as
// Markdown with code blocks and copy buttons. The header shows the cost.
import type { CostInfo } from "../../sidecar/src/protocol.ts";
import { parseInline, parseMarkdown, type Block, type Inline } from "./markdown.ts";
import type { Speaker } from "./transcript.ts";

const MAX_ENTRIES = 300;

export type LogEvents = {
  resetCost: () => void;
  close: () => void;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

/** Copy text. The fallback is for a webview without the Clipboard API. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

function copyButton(text: () => string, label = "Copy"): HTMLButtonElement {
  const b = el("button", "copy", label);
  b.type = "button";
  b.addEventListener("click", () => {
    void copyText(text()).then(() => {
      b.textContent = "Copied";
      window.setTimeout(() => (b.textContent = label), 1200);
    });
  });
  return b;
}

function inlines(parts: Inline[]): Node[] {
  return parts.map((p) => {
    switch (p.kind) {
      case "text":
        return document.createTextNode(p.text);
      case "code":
        return el("code", "", p.text);
      case "bold":
        return el("strong", "", p.text);
      case "italic":
        return el("em", "", p.text);
      case "link": {
        // No anchor: a click would load the page in the Jeeves window.
        const span = el("span", "link", p.text);
        span.title = p.href;
        return span;
      }
    }
  });
}

function block(b: Block): HTMLElement {
  switch (b.kind) {
    case "code": {
      const pre = el("pre", "", el("code", "", b.text));
      return el("div", "code-block", el("div", "code-head", el("span", "", b.lang), copyButton(() => b.text)), pre);
    }
    case "heading":
      return el("h4", "", ...inlines(b.inlines));
    case "list":
      return el(b.ordered ? "ol" : "ul", "", ...b.items.map((item) => el("li", "", ...inlines(item))));
    case "para":
      return el("p", "", ...inlines(b.inlines));
  }
}

const money = (usd: number) => `$${usd.toFixed(usd < 10 ? 3 : 2)}`;

export class LogView {
  private entries = el("div", "log-entries");
  private cost = el("span", "log-cost");
  private stickToEnd = true;
  /** The character name for agent entries. */
  private name = "Jeeves";

  constructor(
    private root: HTMLElement,
    events: LogEvents,
  ) {
    const reset = el("button", "", "Reset cost");
    reset.type = "button";
    reset.title = "Start the cost count again at 0";
    reset.addEventListener("click", () => events.resetCost());
    const close = el("button", "", "Close");
    close.type = "button";
    close.addEventListener("click", () => events.close());
    root.append(el("header", "", el("h2", "", "Log"), this.cost, el("span", "row", reset, close)), this.entries);
    this.cost.textContent = "cost: no data";
    root.addEventListener("scroll", () => {
      this.stickToEnd = root.scrollHeight - root.scrollTop - root.clientHeight < 40;
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    this.root.scrollTop = this.root.scrollHeight;
    this.stickToEnd = true;
  }

  close(): void {
    this.root.hidden = true;
  }

  add(speaker: Speaker | "fault", text: string): void {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const who = { user: "You", head: this.name, tool: "Tool", fault: "Fault" }[speaker];
    const head = el("div", "log-head", el("span", "who", who), el("span", "time", time));
    const body = el("div", "log-body");
    if (speaker === "head") {
      body.append(...parseMarkdown(text).map(block));
      head.append(copyButton(() => text, "Copy reply"));
    } else {
      body.append(el("p", "", ...inlines(speaker === "tool" ? [{ kind: "text", text }] : parseInline(text))));
    }
    this.entries.append(el("div", `log-entry ${speaker}`, head, body));
    while (this.entries.childElementCount > MAX_ENTRIES) this.entries.firstElementChild?.remove();
    if (this.isOpen && this.stickToEnd) this.root.scrollTop = this.root.scrollHeight;
  }

  /** New agent entries use this name. Old entries keep the name of their time. */
  setName(name: string): void {
    this.name = name;
  }

  setCost(c: CostInfo): void {
    const since = new Date(c.since).toLocaleDateString([], { month: "short", day: "numeric" });
    const limit = c.budgetUsd > 0 ? ` of ${money(c.budgetUsd)}` : "";
    this.cost.textContent = `${money(c.spentUsd)}${limit}, ${c.requests} requests since ${since}`;
    this.cost.classList.toggle("blocked", c.blocked);
    if (c.blocked) this.cost.textContent += ". Limit reached.";
  }
}
