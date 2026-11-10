// Brain settings that must survive a restart. A small JSON file in the app data folder.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type BrainSettings = {
  /** The project folder for the Claude Code session. */
  project?: string;
  /** Last session ID for each project folder, to resume it. */
  sessions: Record<string, string>;
};

/** JEEVES_SETTINGS_PATH overrides the location, for tests. */
export const SETTINGS_PATH =
  process.env.JEEVES_SETTINGS_PATH ??
  join(homedir(), "Library", "Application Support", "app.jeeves.desktop", "brain-settings.json");

export async function loadSettings(path = SETTINGS_PATH): Promise<BrainSettings> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<BrainSettings>;
    return {
      project: typeof raw.project === "string" ? raw.project : undefined,
      sessions: raw.sessions && typeof raw.sessions === "object" ? { ...raw.sessions } : {},
    };
  } catch {
    return { sessions: {} };
  }
}

/** Write to a temporary file first, so that a crash cannot leave half a file. */
export async function saveSettings(settings: BrainSettings, path = SETTINGS_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2));
  await rename(tmp, path);
}
