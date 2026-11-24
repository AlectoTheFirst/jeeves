// Cards for open permission requests and questions from the agent. The user can
// answer by voice (the brain routes that) or with the buttons here.
import type { Question } from "../../sidecar/src/protocol.ts";

export type RequestAnswers = {
  permission: (id: number, allow: boolean) => void;
  question: (id: number, answers: Record<string, string> | null) => void;
};

/** The answer to a multiSelect question: the chosen labels in option order, joined with ", ". */
export function joinChoices(q: Question, chosen: ReadonlySet<string>): string {
  return q.options
    .map((o) => o.label)
    .filter((label) => chosen.has(label))
    .join(", ");
}

/** True while the user types in a field, where a focus move would turn the next keys into shortcuts. */
function isEditing(el: Element | null): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

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
    if (!isEditing(document.activeElement)) deny.focus();
  }

  showQuestion(id: number, questions: Question[]): void {
    const card = this.card(id, "question");
    const answers: Record<string, string> = {};
    // With a multiSelect question on the card, the answers go with the Send button only.
    const hasMulti = questions.some((q) => q.multiSelect);
    const complete = () => questions.every((x) => x.question in answers);
    const send = button("Send", "", () => {
      if (complete()) this.answer.question(id, { ...answers });
    });
    send.disabled = true;
    for (const q of questions) {
      const p = document.createElement("p");
      p.textContent = q.question;
      const row = document.createElement("div");
      row.className = "row wrap";
      const chosen = new Set<string>();
      for (const option of q.options) {
        const b = button(option.label, option.description, () => {
          if (q.multiSelect) {
            if (chosen.has(option.label)) chosen.delete(option.label);
            else chosen.add(option.label);
            b.classList.toggle("chosen", chosen.has(option.label));
            if (chosen.size > 0) answers[q.question] = joinChoices(q, chosen);
            else delete answers[q.question];
          } else {
            answers[q.question] = option.label;
            for (const other of row.querySelectorAll("button")) other.classList.toggle("chosen", other === b);
          }
          send.disabled = !complete();
          if (!hasMulti && complete()) this.answer.question(id, { ...answers });
        });
        row.append(b);
      }
      card.append(p, row);
    }
    const actions = document.createElement("div");
    actions.className = "row";
    if (hasMulti) actions.append(send);
    actions.append(button("Skip", "Do not answer", () => this.answer.question(id, null)));
    card.append(actions);
  }

  /** Remove all cards, for example when the brain stops. */
  closeAll(): void {
    for (const id of [...this.cards.keys()]) this.close(id);
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
