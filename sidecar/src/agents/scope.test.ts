import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { globBase, isInside, isProjectRead } from "./scope.ts";

describe("globBase", () => {
  it("keeps the fixed part of the pattern", () => {
    expect(globBase("**/*.ts")).toBe("");
    expect(globBase("*.json")).toBe("");
    expect(globBase("src/**/*.ts")).toBe("src");
    expect(globBase("../../**/*.pem")).toBe("../..");
    expect(globBase("/etc/*")).toBe("/etc");
    expect(globBase("/*")).toBe("/");
    expect(globBase("docs/readme.md")).toBe("docs");
  });
});

describe("isInside", () => {
  const same = (p: string) => p;
  it("accepts the folder and its contents", () => {
    expect(isInside("/p", "/p", same)).toBe(true);
    expect(isInside("/p/a/b.txt", "/p", same)).toBe(true);
    expect(isInside("/p/..data", "/p", same)).toBe(true);
  });
  it("rejects paths outside the folder", () => {
    expect(isInside("/", "/p", same)).toBe(false);
    expect(isInside("/project-2/x", "/p", same)).toBe(false);
    expect(isInside("/p/../q", "/p", same)).toBe(false);
  });
});

describe("isProjectRead", () => {
  const root = mkdtempSync(join(tmpdir(), "jeeves-scope-"));
  const project = join(root, "project");
  const secret = join(root, "secret");
  mkdirSync(project);
  mkdirSync(secret);
  writeFileSync(join(secret, "key.pem"), "x");
  symlinkSync(secret, join(project, "link"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("approves reads in the project folder", () => {
    expect(isProjectRead("Read", { file_path: join(project, "a.ts") }, project)).toBe(true);
    expect(isProjectRead("Read", { file_path: "src/a.ts" }, project)).toBe(true);
    expect(isProjectRead("Glob", { pattern: "**/*.ts" }, project)).toBe(true);
    expect(isProjectRead("Grep", { pattern: "x" }, project)).toBe(true);
    expect(isProjectRead("Grep", { pattern: "x", path: "src" }, project)).toBe(true);
  });

  it("asks for reads outside the project folder", () => {
    expect(isProjectRead("Read", { file_path: join(secret, "key.pem") }, project)).toBe(false);
    expect(isProjectRead("Read", { file_path: "../secret/key.pem" }, project)).toBe(false);
    expect(isProjectRead("Glob", { pattern: "../**/*.pem" }, project)).toBe(false);
    expect(isProjectRead("Glob", { pattern: "*.pem", path: secret }, project)).toBe(false);
    expect(isProjectRead("Glob", { pattern: "/etc/*" }, project)).toBe(false);
    expect(isProjectRead("Grep", { pattern: "x", path: "/" }, project)).toBe(false);
  });

  it("asks for a read through a symlink that leaves the project folder", () => {
    expect(isProjectRead("Read", { file_path: join(project, "link", "key.pem") }, project)).toBe(false);
  });

  it("does not approve other tools", () => {
    expect(isProjectRead("Bash", { command: "ls" }, project)).toBe(false);
    expect(isProjectRead("Write", { file_path: "a.ts" }, project)).toBe(false);
  });
});
