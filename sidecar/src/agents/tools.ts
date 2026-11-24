import { exec } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

function execPromise(
  command: string,
  cwd: string,
  timeout = 60_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout }, (error, stdout, stderr) => {
      if (error && !error.killed && error.code === undefined) {
        reject(error);
        return;
      }
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: error?.code ?? 0,
      });
    });
  });
}

async function globSimple(pattern: string, cwd: string): Promise<string[]> {
  if (pattern.includes("**")) {
    const suffix = pattern.replace("**/", "").replace("**", "");
    const allFiles: string[] = [];
    async function walk(dir: string) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          if (!suffix || fullPath.endsWith(suffix)) {
            allFiles.push(fullPath);
          }
        }
      }
    }
    await walk(cwd);
    return allFiles;
  }

  const dir = pattern.includes("/")
    ? join(cwd, pattern.slice(0, pattern.lastIndexOf("/")))
    : cwd;
  const filePattern = pattern.includes("/")
    ? pattern.slice(pattern.lastIndexOf("/") + 1)
    : pattern;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const regex = new RegExp(
    "^" + filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  return entries
    .filter((e) => e.isFile() && regex.test(e.name))
    .map((e) => join(dir, e.name));
}

async function grepSimple(
  pattern: string,
  path: string,
  cwd: string,
): Promise<string[]> {
  const target = resolve(cwd, path);
  const results: string[] = [];
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    regex = new RegExp(
      pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
  }

  async function searchFile(filePath: string) {
    try {
      const content = await readFile(filePath, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${filePath}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        await searchFile(fullPath);
      }
    }
  }

  const stats = await stat(target).catch(() => null);
  if (stats?.isFile()) {
    await searchFile(target);
  } else if (stats?.isDirectory()) {
    await walk(target);
  }

  return results.slice(0, 100);
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "Read": {
        const filePath = resolve(cwd, String(input.file_path ?? ""));
        const content = await readFile(filePath, "utf8");
        return { content, isError: false };
      }
      case "Bash": {
        const command = String(input.command ?? "");
        const timeout =
          typeof input.timeout === "number" ? input.timeout * 1000 : 60_000;
        const { stdout, stderr, exitCode } = await execPromise(
          command,
          cwd,
          timeout,
        );
        const out = `Exit code: ${exitCode}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`;
        return { content: out, isError: exitCode !== 0 };
      }
      case "Glob": {
        const pattern = String(input.pattern ?? "");
        const matches = await globSimple(pattern, cwd);
        return {
          content: matches.join("\n") || "(no matches)",
          isError: false,
        };
      }
      case "Grep": {
        const pattern = String(input.pattern ?? "");
        const path = String(input.path ?? ".");
        const matches = await grepSimple(pattern, path, cwd);
        return {
          content: matches.join("\n") || "(no matches)",
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
