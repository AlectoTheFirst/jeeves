// The spend since the last cost reset. Pure functions.
//
// Each agent session reports a running total in USD. A resumed Claude Code session
// starts from the total that its transcript saved. So the brain keeps the last total
// of each session and counts only the difference.

export type Spend = { usd: number; requests: number; since: number };

/** The last reported total for each session ID. Only the newest entries are kept. */
export type SessionTotals = Record<string, number>;

const MAX_SESSIONS = 50;

/**
 * The new cost in a result. `base` is the last known total of this session, or
 * undefined if it is not known. A fresh session starts at 0. For a resumed session
 * with no known total, the old turns are in `total`, so this counts nothing.
 */
export function costDelta(total: number, base: number | undefined, resumed: boolean): number {
  if (!Number.isFinite(total) || total < 0) return 0;
  if (base === undefined) return resumed ? 0 : total;
  // A lower total: the session started its count again (for example after /clear).
  return total >= base ? total - base : total;
}

/** Remember a session total. Drops the oldest entries over the limit. */
export function rememberTotal(totals: SessionTotals, sessionId: string, total: number): SessionTotals {
  const next = { ...totals };
  delete next[sessionId];
  next[sessionId] = total;
  const ids = Object.keys(next);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete next[old];
  return next;
}

export function isBlocked(spend: Spend, budgetUsd: number): boolean {
  return budgetUsd > 0 && spend.usd >= budgetUsd;
}

/** Recent project folders: the new one first, no duplicates, at most `max`. */
export function addRecent(recent: readonly string[], path: string, max = 8): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, max);
}
