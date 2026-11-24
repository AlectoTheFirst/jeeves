// The read-only tools run with no question only inside the project folder. A read
// outside it, for example of ~/.ssh, shows a permission card like any other tool.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Tools that only read. They run with no question inside the project folder. */
export const READ_TOOLS = ["Read", "Glob", "Grep"] as const;

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * The real path, with symlinks resolved. For a path that does not exist, the nearest
 * existing parent is resolved and the rest is added again.
 */
export function realPath(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    rest.unshift(basename(head));
    head = parent;
  }
  try {
    head = realpathSync.native(head);
  } catch {
    // Keep the resolved path.
  }
  return rest.length > 0 ? join(head, ...rest) : head;
}

/** True if `path` is `folder` or in it, after symlinks are resolved. */
export function isInside(path: string, folder: string, real: (p: string) => string = realPath): boolean {
  const rel = relative(real(folder), real(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The part of a glob pattern before the first segment with a glob character. */
export function globBase(pattern: string): string {
  const parts = pattern.split("/");
  const fixed: string[] = [];
  for (const part of parts) {
    if (GLOB_CHARS.test(part)) break;
    fixed.push(part);
  }
  // The last fixed part of a pattern without glob characters is a file name.
  if (fixed.length === parts.length) fixed.pop();
  if (pattern.startsWith("/") && fixed.length <= 1) return "/";
  return fixed.join("/");
}

const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** The paths that a read tool touches. Null if the tool is not a read tool. */
export function readTargets(tool: string, input: Record<string, unknown>, cwd: string): string[] | null {
  switch (tool) {
    case "Read":
      return [resolve(cwd, text(input.file_path) ?? "")];
    case "Glob": {
      const base = resolve(cwd, text(input.path) ?? ".");
      return [base, resolve(base, globBase(text(input.pattern) ?? ""))];
    }
    case "Grep":
      return [resolve(cwd, text(input.path) ?? ".")];
    default:
      return null;
  }
}

/** True if a read tool only touches paths in the project folder. */
export function isProjectRead(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  real: (p: string) => string = realPath,
): boolean {
  const targets = readTargets(tool, input, cwd);
  return targets !== null && targets.every((t) => isInside(t, cwd, real));
}
