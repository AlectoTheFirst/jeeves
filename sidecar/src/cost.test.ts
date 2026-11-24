import { describe, expect, it } from "vitest";
import { addRecent, costDelta, isBlocked, rememberTotal } from "./cost.ts";

describe("costDelta", () => {
  it("counts a fresh session from 0", () => {
    expect(costDelta(0.4, undefined, false)).toBe(0.4);
  });

  it("does not count old turns of a resumed session", () => {
    expect(costDelta(3.2, undefined, true)).toBe(0);
    expect(costDelta(3.5, 3.2, true)).toBeCloseTo(0.3);
  });

  it("counts the full total after the session count starts again", () => {
    expect(costDelta(0.1, 3.2, false)).toBe(0.1);
  });

  it("ignores bad totals", () => {
    expect(costDelta(Number.NaN, 1, false)).toBe(0);
    expect(costDelta(-1, undefined, false)).toBe(0);
  });
});

describe("rememberTotal", () => {
  it("keeps the newest 50 sessions", () => {
    let totals = {};
    for (let i = 0; i < 60; i++) totals = rememberTotal(totals, `s${i}`, i);
    expect(Object.keys(totals)).toHaveLength(50);
    expect(totals).not.toHaveProperty("s0");
    expect(rememberTotal(totals, "s10", 99)).toHaveProperty("s10", 99);
  });
});

describe("isBlocked", () => {
  it("blocks only with a limit that is reached", () => {
    expect(isBlocked({ usd: 5, requests: 1, since: 0 }, 0)).toBe(false);
    expect(isBlocked({ usd: 4.99, requests: 1, since: 0 }, 5)).toBe(false);
    expect(isBlocked({ usd: 5, requests: 1, since: 0 }, 5)).toBe(true);
  });
});

describe("addRecent", () => {
  it("puts the new folder first with no duplicates", () => {
    expect(addRecent(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
    expect(addRecent(["/a", "/b"], "/c", 2)).toEqual(["/c", "/a"]);
  });
});
