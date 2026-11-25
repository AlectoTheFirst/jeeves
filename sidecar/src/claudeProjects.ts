// The project folders that Claude Code knows, from its own config file. Jeeves only
// reads this file. It never writes to it.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_PROJECTS = 100;

/** The system temporary folders. */
const TEMPORARY_ROOT = /^\/(?:private\/)?(?:tmp|var\/folders)\//;
/** A scratchpad folder of an agent session, at any depth. */
const SCRATCHPAD = /\/scratchpad(?:\/|$)/;

export const isTemporary = (path: string) => TEMPORARY_ROOT.test(path) || SCRATCHPAD.test(path);

/** The folder name under ~/.claude/projects: each character that is not a letter or digit becomes "-". */
export const sessionFolderName = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");

/**
 * The project paths in the "projects" map of ~/.claude.json, the most recent first.
 * `lastUsed` gives a time in ms for a path, 0 if not known. `exists` checks for a folder.
 */
export function pickClaudeProjects(
  raw: unknown,
  exists: (path: string) => boolean,
  lastUsed: (path: string, entry: Record<string, unknown>) => number,
): string[] {
  const projects = (raw as { projects?: unknown })?.projects;
  if (typeof projects !== "object" || projects === null) return [];
  return Object.entries(projects as Record<string, unknown>)
    .filter(([path]) => path.startsWith("/") && !isTemporary(path) && exists(path))
    .map(([path, entry]) => ({ path, time: lastUsed(path, (entry ?? {}) as Record<string, unknown>) }))
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_PROJECTS)
    .map((p) => p.path);
}

/**
 * The recent Jeeves folders first, then the Claude Code projects, no duplicates.
 * Temporary folders are dropped, but not the active project.
 */
export function mergeProjects(recent: readonly string[], claude: readonly string[], active = ""): string[] {
  return [...new Set([...recent.filter((p) => p === active || !isTemporary(p)), ...claude])];
}

const isFolder = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const mtime = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/** Read the Claude Code projects. An empty list if the file is missing or bad. */
export function loadClaudeProjects(home = homedir()): string[] {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const file = configDir ? join(configDir, ".claude.json") : join(home, ".claude.json");
  const sessions = join(configDir ?? join(home, ".claude"), "projects");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  return pickClaudeProjects(raw, isFolder, (path, entry) => {
    const saved = typeof entry.lastSessionModified === "number" ? entry.lastSessionModified : 0;
    return Math.max(saved, mtime(join(sessions, sessionFolderName(path))));
  });
}
