// Brain settings that must survive a restart. A small JSON file in the app data folder.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionTotals, Spend } from "./cost.ts";

export type BrainSettings = {
  /** The project folder for the Claude Code session. */
  project?: string;
  /** Last session ID for each project folder, to resume it. */
  sessions: Record<string, string>;
  /** The user configuration. Checked with parseConfig when it is loaded. */
  config?: unknown;
  /** Recent project folders, the newest first. */
  recent: string[];
  /** The spend since the last cost reset. */
  spend: Spend;
  /** The last reported cost total of each agent session. */
  sessionTotals: SessionTotals;
};

export const emptySettings = (): BrainSettings => ({
  sessions: {},
  recent: [],
  spend: { usd: 0, requests: 0, since: Date.now() },
  sessionTotals: {},
});

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** JEEVES_SETTINGS_PATH overrides the location, for tests. */
export const SETTINGS_PATH =
  process.env.JEEVES_SETTINGS_PATH ??
  join(homedir(), "Library", "Application Support", "app.jeeves.desktop", "brain-settings.json");

export async function loadSettings(path = SETTINGS_PATH): Promise<BrainSettings> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<BrainSettings>;
    const empty = emptySettings();
    const spend = (raw.spend ?? {}) as Partial<Spend>;
    const totals = raw.sessionTotals && typeof raw.sessionTotals === "object" ? raw.sessionTotals : {};
    const project = typeof raw.project === "string" ? raw.project : undefined;
    const recent = Array.isArray(raw.recent) ? raw.recent.filter((p): p is string => typeof p === "string") : [];
    return {
      project,
      sessions: raw.sessions && typeof raw.sessions === "object" ? { ...raw.sessions } : {},
      config: raw.config,
      // Files from before the list have only the current project.
      recent: recent.length === 0 && project ? [project] : recent.slice(0, 8),
      spend: {
        usd: isNum(spend.usd) ? spend.usd : 0,
        requests: isNum(spend.requests) ? spend.requests : 0,
        since: isNum(spend.since) ? spend.since : empty.spend.since,
      },
      sessionTotals: Object.fromEntries(Object.entries(totals).filter(([, v]) => isNum(v))),
    };
  } catch {
    return emptySettings();
  }
}

/** Write to a temporary file first, so that a crash cannot leave half a file. */
export async function saveSettings(settings: BrainSettings, path = SETTINGS_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2));
  await rename(tmp, path);
}
