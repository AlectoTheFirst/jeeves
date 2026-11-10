// Cards for open permission requests and questions from the agent. The user can
// answer by voice (the brain routes that) or with the buttons here.
import type { Question } from "../../sidecar/src/protocol.ts";

export type RequestAnswers = {
  permission: (id: number, allow: boolean) => void;
  question: (id: number, answers: Record<string, string> | null) => void;
};

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

export class RequestCards {
  private cards = new Map<number, HTMLElement>();

  constructor(
    private root: HTMLElement,
    private answer: RequestAnswers,
  ) {}

  get openCount(): number {
    return this.cards.size;
  }

  showPermission(id: number, text: string, detail: string): void {
    const card = this.card(id, "permission");
    const p = document.createElement("p");
    p.textContent = text;
    card.append(p);
    if (detail) {
      const pre = document.createElement("pre");
      pre.textContent = detail;
      card.append(pre);
    }
    const row = document.createElement("div");
    row.className = "row";
    // Deny comes first and has the focus, so that a stray Enter key does not approve.
    const deny = button("Deny", "", () => this.answer.permission(id, false));
    row.append(deny, button("Allow", "", () => this.answer.permission(id, true)));
    card.append(row);
    deny.focus();
  }

  showQuestion(id: number, questions: Question[]): void {
    const card = this.card(id, "question");
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const p = document.createElement("p");
      p.textContent = q.question;
      const row = document.createElement("div");
      row.className = "row wrap";
      for (const option of q.options) {
        const b = button(option.label, option.description, () => {
          answers[q.question] = option.label;
          for (const other of row.querySelectorAll("button")) other.classList.toggle("chosen", other === b);
          if (questions.every((x) => x.question in answers)) this.answer.question(id, { ...answers });
        });
        row.append(b);
      }
      card.append(p, row);
    }
    const skip = document.createElement("div");
    skip.className = "row";
    skip.append(button("Skip", "Do not answer", () => this.answer.question(id, null)));
    card.append(skip);
  }

  close(id: number): void {
    this.cards.get(id)?.remove();
    this.cards.delete(id);
  }

  private card(id: number, kind: string): HTMLElement {
    this.close(id);
    const card = document.createElement("div");
    card.className = `card ${kind}`;
    this.root.append(card);
    this.cards.set(id, card);
    return card;
  }
}
