import { describe, expect, it } from "vitest";
import { joinChoices } from "./requests.ts";

describe("joinChoices", () => {
  const q = {
    question: "Which files?",
    header: "Files",
    multiSelect: true,
    options: ["a.ts", "b.ts", "c.ts"].map((label) => ({ label, description: "" })),
  };

  it("joins the chosen labels in option order", () => {
    expect(joinChoices(q, new Set(["c.ts", "a.ts"]))).toBe("a.ts, c.ts");
  });

  it("ignores labels that are not options", () => {
    expect(joinChoices(q, new Set(["b.ts", "x.ts"]))).toBe("b.ts");
  });
});
