// The conversation log under the head: what the user said, the agent's answers and
// short tool lines. It scrolls and keeps the last lines only.

const MAX_LINES = 30;

export type Speaker = "user" | "head" | "tool";

export class Transcript {
  private hideTimer: number | undefined;
  private pinnedValue = false;
  /** Without new lines for this time, the transcript fades away, unless it is pinned. */
  private hideAfterMs = 10_000;

  constructor(private root: HTMLElement) {
    root.addEventListener("pointerenter", () => this.show());
    root.addEventListener("pointerleave", () => this.show());
  }

  get pinned(): boolean {
    return this.pinnedValue;
  }

  /** Pinned = always visible. Otherwise it hides after `hideSeconds` without new lines. */
  configure(pinned: boolean, hideSeconds: number): void {
    const changed = pinned !== this.pinnedValue || hideSeconds * 1000 !== this.hideAfterMs;
    this.pinnedValue = pinned;
    this.hideAfterMs = hideSeconds * 1000;
    if (changed) this.show();
  }

  /** Show the transcript now, and start the hide timer again. */
  show(): void {
    clearTimeout(this.hideTimer);
    this.root.classList.remove("faded");
    if (this.pinnedValue) return;
    this.hideTimer = window.setTimeout(() => {
      if (this.root.matches(":hover")) this.show();
      else this.root.classList.add("faded");
    }, this.hideAfterMs);
  }

  /** Add a line. Returns it, so that a pending line can change later. */
  add(speaker: Speaker, text: string, pending = false): HTMLElement {
    const atBottom = this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight < 24;
    const line = document.createElement("div");
    line.className = `line ${speaker}${pending ? " pending" : ""}`;
    line.textContent = text;
    // Long answers show 4 lines. A click shows all of the text.
    if (speaker === "head") {
      line.classList.add("clamped");
      line.title = "Click to show all";
      line.addEventListener("click", () => line.classList.toggle("clamped"));
    }
    this.root.append(line);
    while (this.root.childElementCount > MAX_LINES) this.root.firstElementChild?.remove();
    // Follow new lines, unless the user scrolled up to read.
    if (atBottom) this.root.scrollTop = this.root.scrollHeight;
    this.show();
    return line;
  }

  /** Replace the text of a pending line and mark it as final. */
  settle(line: HTMLElement, text: string): void {
    line.textContent = text;
    line.classList.remove("pending");
    this.show();
  }

  remove(line: HTMLElement): void {
    line.remove();
  }
}
