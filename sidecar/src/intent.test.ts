import { describe, expect, it } from "vitest";
import { classifyYesNo, isStopCommand, matchOption, matchProject, parseProjectSwitch } from "./intent.ts";
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
    ["yes please", "allow"],
    ["sure, go for it", "allow"],
    ["Okay, don't do that", "deny"],
    ["ok stop", "deny"],
    ["sure, cancel it", "deny"],
    ["fine, not now", "deny"],
    ["yes, no wait", "deny"],
    ["ok I can't say", "deny"],
    ["go back", "unclear"],
    ["ok now fix the tests", "unclear"],
    ["okay so first read the file and then do not touch the tests", "unclear"],
    ["no, use the other folder and run the tests again after that", "deny"],
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
    expect(toolPhrase("mcp__home-assistant__ha_call_service", {})).toBe("Using ha call service from home assistant.");
    expect(permissionQuestion("Bash", { command: "rm -rf build" })).toBe("I want to run rm -rf build. Allow?");
    expect(
      permissionQuestion("Bash", { command: "rm -rf ~ ; echo", description: "List files" }, "Claude wants to list files"),
    ).toBe("I want to run rm -rf ~ ; echo. Allow?");
    expect(permissionQuestion("Bash", { command: "a b c d e f g h i j" })).toBe(
      "I want to run a b c d e f g h and more. Allow?",
    );
    expect(permissionQuestion("Write", {}, "Claude wants to write hello.txt")).toBe(
      "I want to write hello.txt. Allow?",
    );
  });
});

describe("project switch", () => {
  it("finds the project name in a switch command", () => {
    expect(parseProjectSwitch("Switch to project Jeeves.")).toBe("jeeves");
    expect(parseProjectSwitch("please change to the project star garden")).toBe("star garden");
    expect(parseProjectSwitch("Open project star garden, please")).toBe("star garden");
    expect(parseProjectSwitch("switch to the other branch")).toBeNull();
    expect(parseProjectSwitch("what is in this project")).toBeNull();
  });

  it("matches a spoken name to a recent folder", () => {
    const recent = ["/Users/a/code/jeeves", "/Users/a/code/ai-code/star_garden", "/Users/a/code/jeeves-old"];
    expect(matchProject("jeeves", recent)).toBe("/Users/a/code/jeeves");
    expect(matchProject("star garden", recent)).toBe("/Users/a/code/ai-code/star_garden");
    expect(matchProject("star", recent)).toBe("/Users/a/code/ai-code/star_garden");
    expect(matchProject("banana", recent)).toBeNull();
    expect(matchProject("", recent)).toBeNull();
  });
});
