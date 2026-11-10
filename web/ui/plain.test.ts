import { describe, expect, it } from "vitest";
import { toPlainText } from "./plain.ts";

describe("toPlainText", () => {
  it("removes bold, inline code and headings", () => {
    expect(toPlainText("## Result\n- **`add(a, b)`**: takes `a` and `b`.")).toBe(
      "Result\n- add(a, b): takes a and b.",
    );
  });

  it("keeps code but removes fence lines", () => {
    expect(toPlainText("Fix:\n```js\nreturn a + b;\n```")).toBe("Fix:\nreturn a + b;");
  });

  it("removes italics but keeps multiplication", () => {
    expect(toPlainText("This is *important*. 2 * 3 = 6")).toBe("This is important. 2 * 3 = 6");
  });

  it("keeps link text only", () => {
    expect(toPlainText("See [the docs](https://example.com).")).toBe("See the docs.");
  });
});
