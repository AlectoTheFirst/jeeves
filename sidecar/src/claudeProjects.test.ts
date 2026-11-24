import { describe, expect, it } from "vitest";
import { mergeProjects, pickClaudeProjects, sessionFolderName } from "./claudeProjects.ts";

describe("pickClaudeProjects", () => {
  const raw = {
    projects: {
      "/Users/a/code/old": {},
      "/Users/a/code/jeeves": { lastSessionModified: 300 },
      "/Users/a/code/gone": { lastSessionModified: 900 },
      "/private/tmp/claude-501/x/scratchpad/demo": { lastSessionModified: 999 },
      "/tmp/try": {},
      "/Users/a/work/scratchpad": {},
      "relative/path": {},
      "/Users/a/code/star_garden": {},
    },
  };
  const exists = (p: string) => p !== "/Users/a/code/gone";
  const times: Record<string, number> = { "/Users/a/code/star_garden": 500 };
  const lastUsed = (p: string, e: Record<string, unknown>) => (e.lastSessionModified as number) ?? times[p] ?? 0;

  it("keeps existing, non-temporary folders, the most recent first", () => {
    expect(pickClaudeProjects(raw, exists, lastUsed)).toEqual([
      "/Users/a/code/star_garden",
      "/Users/a/code/jeeves",
      "/Users/a/code/old",
    ]);
  });

  it("gives an empty list for a bad file", () => {
    expect(pickClaudeProjects(null, exists, lastUsed)).toEqual([]);
    expect(pickClaudeProjects({ projects: 3 }, exists, lastUsed)).toEqual([]);
  });
});

describe("mergeProjects", () => {
  it("puts the Jeeves folders first, with no duplicates", () => {
    expect(mergeProjects(["/b", "/a"], ["/a", "/c"])).toEqual(["/b", "/a", "/c"]);
  });

  it("drops temporary folders, but not the active project", () => {
    expect(mergeProjects(["/tmp/x", "/private/tmp/y/scratchpad/demo", "/a"], ["/c"])).toEqual(["/a", "/c"]);
    expect(mergeProjects(["/tmp/x", "/a"], [], "/tmp/x")).toEqual(["/tmp/x", "/a"]);
  });
});

describe("sessionFolderName", () => {
  it("makes the folder name that Claude Code uses", () => {
    expect(sessionFolderName("/Users/a/code/ai-code/star_garden")).toBe("-Users-a-code-ai-code-star-garden");
  });
});
