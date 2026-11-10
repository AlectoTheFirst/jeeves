import { describe, expect, it } from "vitest";
import { classifyYesNo, isStopCommand, matchOption } from "./intent.ts";
import { firstSentences, permissionQuestion, splitReply, toolPhrase, toSpeakable } from "./spoken.ts";

describe("classifyYesNo", () => {
  it.each([
    ["Yes.", "allow"],
    ["yeah go ahead", "allow"],
    ["Okay, do it", "allow"],
    ["No!", "deny"],
    ["don't do that", "deny"],
    ["nope", "deny"],
    ["what is this", "unclear"],
    ["", "unclear"],
  ])("%s -> %s", (text, expected) => {
    expect(classifyYesNo(text)).toBe(expected);
  });
});

describe("isStopCommand", () => {
  it("knows short stop requests only", () => {
    expect(isStopCommand("Stop!")).toBe(true);
    expect(isStopCommand("cancel that please")).toBe(true);
    expect(isStopCommand("stop the server and run the tests")).toBe(false);
  });
});

describe("matchOption", () => {
  const labels = ["Liam", "Liam Pro", "Tyler"];
  it("matches a label, longest first", () => {
    expect(matchOption("I want Liam Pro please", labels)).toBe(1);
    expect(matchOption("tyler", labels)).toBe(2);
  });
  it("matches ordinals", () => {
    expect(matchOption("the second one", labels)).toBe(1);
    expect(matchOption("option 3", labels)).toBe(2);
    expect(matchOption("the last one", labels)).toBe(2);
  });
  it("returns -1 when nothing matches", () => {
    expect(matchOption("pizza", labels)).toBe(-1);
    expect(matchOption("option 9", labels)).toBe(-1);
  });
});

describe("spoken text", () => {
  it("takes the SPOKEN line out of the reply", () => {
    const reply = "SPOKEN: All 12 tests pass. Nice!\n\n## Details\n- `npm test`: ok";
    expect(splitReply(reply)).toEqual({ spoken: "All 12 tests pass. Nice!", display: "## Details\n- `npm test`: ok" });
  });

  it("falls back to the first 2 sentences without code", () => {
    const reply = "I fixed the bug. The `parse` call was wrong. Here is the diff:\n```ts\nx()\n```";
    expect(splitReply(reply).spoken).toBe("I fixed the bug. The parse call was wrong.");
  });

  it("strips markdown for speech", () => {
    expect(toSpeakable("**Done**: see [the file](a.md)")).toBe("Done: see the file");
    expect(firstSentences("One. Two! Three?", 2)).toBe("One. Two!");
  });

  it("makes tool and permission phrases", () => {
    expect(toolPhrase("Bash", { command: "npm test", description: "Run the tests" })).toBe("Run the tests.");
    expect(toolPhrase("Read", { file_path: "/a/b/c.ts" })).toBe("Reading c.ts.");
    expect(toolPhrase("TodoWrite", {})).toBe("");
    expect(permissionQuestion("Bash", { command: "rm -rf build" })).toBe(
      "Claude wants to do this: Running rm -rf build. Allow?",
    );
    expect(permissionQuestion("Write", {}, "Claude wants to write hello.txt")).toBe(
      "Claude wants to write hello.txt. Allow?",
    );
  });
});
