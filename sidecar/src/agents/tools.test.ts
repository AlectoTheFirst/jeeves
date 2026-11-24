import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isProjectRead } from "./scope.ts";
import { executeTool, globRegex, grepSimple } from "./tools.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jeeves-tools-"));
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "a.ts"), "const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const needle = 2;\n");
  writeFileSync(join(root, "src", "deep", "c.ts"), "needle\nneedle\n");
  writeFileSync(join(root, "src", "d.json"), "{}\n");
  writeFileSync(join(root, "node_modules", "pkg", "e.ts"), "needle\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([110, 101, 101, 100, 108, 101, 0, 1]));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const lines = (text: string) => text.split("\n").sort();

describe("globRegex", () => {
  it("matches folders with ** and 1 segment with *", () => {
    expect(globRegex("**/*.ts").test("a.ts")).toBe(true);
    expect(globRegex("**/*.ts").test("src/deep/c.ts")).toBe(true);
    expect(globRegex("*.ts").test("src/b.ts")).toBe(false);
    expect(globRegex("src/*.{ts,json}").test("src/d.json")).toBe(true);
    expect(globRegex("[!a].ts").test("a.ts")).toBe(false);
    expect(globRegex("a.ts").test("abts")).toBe(false);
  });
});

describe("Glob", () => {
  it("finds files for a recursive pattern and skips node_modules", async () => {
    const r = await executeTool("Glob", { pattern: "**/*.ts" }, root);
    expect(lines(r.content)).toEqual(
      [join(root, "a.ts"), join(root, "src", "b.ts"), join(root, "src", "deep", "c.ts")].sort(),
    );
  });

  it("matches a pattern with a fixed folder", async () => {
    const r = await executeTool("Glob", { pattern: "src/**/*.ts" }, root);
    expect(lines(r.content)).toEqual([join(root, "src", "b.ts"), join(root, "src", "deep", "c.ts")].sort());
  });

  it("does not leave the base folder through .. after a glob segment", async () => {
    const r = await executeTool("Glob", { pattern: "s*/../../../../../../etc/*" }, root);
    expect(r.content).toBe("(no matches)");
  });
});

describe("Glob path", () => {
  it("resolves the pattern from the path, as the scope check does", async () => {
    const input = { path: "src/deep", pattern: "../*" };
    expect(isProjectRead("Glob", input, root)).toBe(true);
    const r = await executeTool("Glob", input, root);
    expect(lines(r.content)).toEqual([join(root, "src", "b.ts"), join(root, "src", "d.json")].sort());
  });
});

describe("Grep", () => {
  it("skips node_modules and binary files", async () => {
    const r = await executeTool("Grep", { pattern: "needle", path: "." }, root);
    expect(lines(r.content)).toEqual(
      [
        `${join(root, "src", "b.ts")}:1: export const needle = 2;`,
        `${join(root, "src", "deep", "c.ts")}:1: needle`,
        `${join(root, "src", "deep", "c.ts")}:2: needle`,
      ].sort(),
    );
  });

  it("stops a slow search at the time limit", async () => {
    writeFileSync(join(root, "slow.txt"), `${"a".repeat(40)}b\n`);
    const started = Date.now();
    const r = await grepSimple("^(a+)+$", "slow.txt", root, undefined, 300);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.note).toContain("stopped");
  });

  it("stops at an abort", async () => {
    const controller = new AbortController();
    const pending = grepSimple("^(a+)+$", "slow.txt", root, controller.signal, 60_000);
    controller.abort();
    expect((await pending).note).toBe("Stopped.");
  });
});

describe("Bash", () => {
  it("kills the command on an abort", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = executeTool("Bash", { command: "sleep 30" }, root, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const r = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.content).toContain("stopped");
  });

  it("returns the output and the exit code", async () => {
    const r = await executeTool("Bash", { command: "echo hi; exit 3" }, root);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Exit code: 3");
    expect(r.content).toContain("hi");
  });
});
