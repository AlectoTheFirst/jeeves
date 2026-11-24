import { spawn } from "node:child_process";
import { open, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type Anthropic from "@anthropic-ai/sdk";

export type ToolResult = { content: string; isError: boolean };

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "Read",
    description:
      "Read a file from the local filesystem. The file_path must be an absolute path, not a relative path. Returns the contents of the file.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The absolute path of the file to read",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "Bash",
    description:
      "Execute a bash command in the working directory. Returns the stdout, stderr, and exit code of the command.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default 60)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "Glob",
    description:
      "Find files matching a glob pattern. Returns a list of matching absolute file paths.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The glob pattern, e.g. '**/*.ts' or '*.json'",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "Grep",
    description:
      "Search for a pattern in files. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The regex or literal pattern to search for",
        },
        path: {
          type: "string",
          description: "The directory or file to search in",
        },
      },
      required: ["pattern", "path"],
    },
  },
  {
    name: "Write",
    description:
      "Write content to a file. Overwrites the file if it exists. The file_path must be an absolute path.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The absolute path of the file to write",
        },
        content: {
          type: "string",
          description: "The content to write",
        },
      },
      required: ["file_path", "content"],
    },
  },
];

/** The longest time that a Bash command can run. */
export const MAX_BASH_TIMEOUT = 600_000;
/** The characters of stdout and of stderr that a Bash command keeps. */
const MAX_OUTPUT = 1_000_000;
/** The Read tool reads at most this many bytes of a file. */
const MAX_READ_BYTES = 256_000;
export const MAX_GLOB_RESULTS = 1000;
export const MAX_GREP_RESULTS = 100;
const GREP_TIME_LIMIT = 20_000;
const MAX_GREP_FILE_SIZE = 2_000_000;
/** Folders that Glob and Grep do not enter unless the pattern names them. */
const SKIP_DIRS = [".git", "node_modules"];
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Runs the command in its own process group. A timeout or an abort kills the whole
 * group, so the children of the shell stop too.
 */
function execPromise(
  command: string,
  cwd: string,
  timeout = 60_000,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Stopped."));
      return;
    }
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killedFor = "";
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        // The group has exited.
      }
    };
    const kill = (reason: string) => {
      if (killedFor) return;
      killedFor = reason;
      killGroup("SIGTERM");
      forceKill = setTimeout(() => killGroup("SIGKILL"), 2_000);
    };
    const timer = setTimeout(() => kill(`timed out after ${timeout / 1000} s`), timeout);
    const onAbort = () => kill("stopped");
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      signal?.removeEventListener("abort", onAbort);
    };
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr!.on("data", (d: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: killedFor ? `${stderr.slice(0, MAX_OUTPUT)}\nThe command was killed: ${killedFor}.` : stderr.slice(0, MAX_OUTPUT),
        exitCode: code ?? 1,
      });
    });
  });
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A regular expression for a glob pattern. It matches a relative path with "/" separators. */
export function globRegex(pattern: string): RegExp {
  let re = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // "**/" matches 0 or more folders. "**" in other places matches any text.
        if (pattern[i + 2] === "/") {
          re += "(?:[^/]*/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) {
      re += "|";
    } else if (c === "[" && pattern.indexOf("]", i + 2) !== -1) {
      const close = pattern.indexOf("]", i + 2);
      let body = pattern.slice(i + 1, close).replace(/\\/g, "\\\\");
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      re += `[${body}]`;
      i = close;
    } else {
      re += escapeRegex(c);
    }
  }
  // An unclosed "{" leaves open groups.
  re += ")".repeat(braces);
  return new RegExp(`^${re}$`);
}

/**
 * The files that match the pattern, relative to `cwd`. The walk starts at the segments
 * before the first segment with a glob character, the folder that the scope check tests,
 * and only goes down from there.
 */
async function globSimple(
  pattern: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ matches: string[]; full: boolean }> {
  const parts = pattern.split("/");
  const first = parts.findIndex((p) => GLOB_CHARS.test(p));
  if (first === -1) {
    const path = resolve(cwd, pattern);
    const stats = await stat(path).catch(() => null);
    return { matches: stats?.isFile() ? [path] : [], full: false };
  }
  const fixed = parts.slice(0, first).join("/");
  const base = resolve(cwd, fixed === "" && pattern.startsWith("/") ? "/" : fixed);
  const rest = parts.slice(first).join("/");
  const regex = globRegex(rest);
  const maxDepth = rest.includes("**") ? Infinity : parts.length - first;
  const skip = SKIP_DIRS.filter((d) => !rest.includes(d));
  const matches: string[] = [];

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (matches.length >= MAX_GLOB_RESULTS || signal?.aborted) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (matches.length >= MAX_GLOB_RESULTS) return;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < maxDepth && !skip.includes(entry.name)) {
          await walk(join(dir, entry.name), relPath, depth + 1);
        }
      } else if (entry.isFile() && regex.test(relPath)) {
        matches.push(join(dir, entry.name));
      }
    }
  }

  await walk(base, "", 1);
  return { matches, full: matches.length >= MAX_GLOB_RESULTS };
}

// The search runs in a worker thread, so a slow regular expression cannot block the
// sidecar. The worker is terminated after the time limit or on an abort. The source is a
// string because the compiled binary has no separate worker file.
const GREP_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { source, flags, target, max, maxSize, skip } = workerData;
const regex = new RegExp(source, flags);
let count = 0;

function searchFile(file) {
  let data;
  try {
    if (fs.statSync(file).size > maxSize) return;
    data = fs.readFileSync(file);
  } catch {
    return;
  }
  if (data.subarray(0, 8192).includes(0)) return;
  const lines = data.toString("utf8").split("\\n");
  for (let i = 0; i < lines.length && count < max; i++) {
    if (regex.test(lines[i])) {
      count++;
      parentPort.postMessage({ line: file + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 500) });
    }
  }
}

function walk(root) {
  const stack = [root];
  while (stack.length > 0 && count < max) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (count >= max) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.includes(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        searchFile(full);
      }
    }
  }
}

let stats = null;
try {
  stats = fs.statSync(target);
} catch {}
if (stats && stats.isFile()) searchFile(target);
else if (stats && stats.isDirectory()) walk(target);
parentPort.postMessage({ done: true, full: count >= max });
`;

/** The matching lines, and a note if the search stopped early. */
export function grepSimple(
  pattern: string,
  path: string,
  cwd: string,
  signal?: AbortSignal,
  timeLimit = GREP_TIME_LIMIT,
): Promise<{ lines: string[]; note: string }> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    regex = new RegExp(escapeRegex(pattern), "i");
  }
  const lines: string[] = [];
  return new Promise((done) => {
    if (signal?.aborted) {
      done({ lines, note: "Stopped." });
      return;
    }
    const worker = new Worker(GREP_WORKER, {
      eval: true,
      workerData: {
        source: regex.source,
        flags: regex.flags,
        target: resolve(cwd, path),
        max: MAX_GREP_RESULTS,
        maxSize: MAX_GREP_FILE_SIZE,
        skip: SKIP_DIRS.filter((d) => !path.includes(d)),
      },
    });
    let finished = false;
    const finish = (note: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      done({ lines, note });
    };
    const timer = setTimeout(() => finish(`The search stopped after ${timeLimit / 1000} s.`), timeLimit);
    const onAbort = () => finish("Stopped.");
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (msg: { line?: string; done?: boolean; full?: boolean }) => {
      if (msg.line !== undefined) lines.push(msg.line);
      if (msg.done) finish(msg.full ? `The search stopped at ${MAX_GREP_RESULTS} matches.` : "");
    });
    worker.on("error", (err: Error) => finish(`The search failed: ${err.message}`));
    worker.on("exit", () => finish("The search ended early."));
  });
}

/** The first MAX_READ_BYTES of a file as UTF-8, with a note if the file is longer. */
async function readHead(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, MAX_READ_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return size > bytesRead ? `${text}\n[The file has ${size} bytes. Only the first ${bytesRead} are shown.]` : text;
  } finally {
    await file.close();
  }
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "Read": {
        const filePath = resolve(cwd, String(input.file_path ?? ""));
        return { content: await readHead(filePath), isError: false };
      }
      case "Bash": {
        const command = String(input.command ?? "");
        const timeout =
          typeof input.timeout === "number" && input.timeout > 0
            ? Math.min(input.timeout * 1000, MAX_BASH_TIMEOUT)
            : 60_000;
        const { stdout, stderr, exitCode } = await execPromise(
          command,
          cwd,
          timeout,
          signal,
        );
        const out = `Exit code: ${exitCode}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`;
        return { content: out, isError: exitCode !== 0 };
      }
      case "Glob": {
        const pattern = String(input.pattern ?? "");
        // The same base folder as readTargets in scope.ts.
        const base =
          typeof input.path === "string" && input.path !== "" ? resolve(cwd, input.path) : cwd;
        const { matches, full } = await globSimple(pattern, base, signal);
        const note = full ? `\nThe list stopped at ${MAX_GLOB_RESULTS} files.` : "";
        return {
          content: (matches.join("\n") || "(no matches)") + note,
          isError: false,
        };
      }
      case "Grep": {
        const pattern = String(input.pattern ?? "");
        const path = String(input.path ?? ".");
        const { lines, note } = await grepSimple(pattern, path, cwd, signal);
        return {
          content: (lines.join("\n") || "(no matches)") + (note ? `\n${note}` : ""),
          isError: false,
        };
      }
      case "Write": {
        const filePath = resolve(cwd, String(input.file_path ?? ""));
        const content = String(input.content ?? "");
        await writeFile(filePath, content, "utf8");
        return { content: `Wrote ${filePath}`, isError: false };
      }
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}
