// The short conversation log under the head. Keeps only the last few lines.

const MAX_LINES = 4;

export type Speaker = "user" | "head";

export class Transcript {
  constructor(private root: HTMLElement) {}

  /** Add a line. Returns it, so that a pending line can change later. */
  add(speaker: Speaker, text: string, pending = false): HTMLElement {
    const line = document.createElement("div");
    line.className = `line ${speaker}${pending ? " pending" : ""}`;
    line.textContent = text;
    this.root.append(line);
    while (this.root.childElementCount > MAX_LINES) this.root.firstElementChild?.remove();
    return line;
  }

  /** Replace the text of a pending line and mark it as final. */
  settle(line: HTMLElement, text: string): void {
    line.textContent = text;
    line.classList.remove("pending");
  }

  remove(line: HTMLElement): void {
    line.remove();
  }
}
