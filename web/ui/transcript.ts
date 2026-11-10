// The conversation log under the head: what the user said, the agent's answers and
// short tool lines. It scrolls and keeps the last lines only.

const MAX_LINES = 30;
/** Without new lines for this time, the transcript fades away, unless it is pinned. */
const HIDE_AFTER_MS = 10_000;
const PIN_KEY = "jeeves.transcript.pinned";

export type Speaker = "user" | "head" | "tool";

export class Transcript {
  private hideTimer: number | undefined;
  private pinnedValue = false;

  constructor(private root: HTMLElement) {
    try {
      this.pinnedValue = localStorage.getItem(PIN_KEY) === "1";
    } catch {
      // No storage: start in auto-hide mode.
    }
    root.addEventListener("pointerenter", () => this.show());
    root.addEventListener("pointerleave", () => this.show());
  }

  get pinned(): boolean {
    return this.pinnedValue;
  }

  /** Switch between always visible and auto-hide. Returns the new mode. */
  togglePinned(): boolean {
    this.pinnedValue = !this.pinnedValue;
    try {
      localStorage.setItem(PIN_KEY, this.pinnedValue ? "1" : "0");
    } catch {
      // The mode then lasts for this session only.
    }
    this.show();
    return this.pinnedValue;
  }

  /** Show the transcript now, and start the hide timer again. */
  show(): void {
    clearTimeout(this.hideTimer);
    this.root.classList.remove("faded");
    if (this.pinnedValue) return;
    this.hideTimer = window.setTimeout(() => {
      if (this.root.matches(":hover")) this.show();
      else this.root.classList.add("faded");
    }, HIDE_AFTER_MS);
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
