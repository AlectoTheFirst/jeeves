import { describe, expect, it } from "vitest";
import { fitInto } from "./fit.ts";

const area = { x: 0, y: 25, width: 1440, height: 875 };

describe("fitInto", () => {
  it("keeps a window that fits", () => {
    const win = { x: 100, y: 100, width: 420, height: 520 };
    expect(fitInto(win, area)).toEqual(win);
  });

  it("moves a window back from the right and bottom borders", () => {
    expect(fitInto({ x: 1300, y: 700, width: 420, height: 520 }, area)).toEqual({ x: 1020, y: 380, width: 420, height: 520 });
  });

  it("moves a window back from the left and top borders", () => {
    expect(fitInto({ x: -200, y: 0, width: 420, height: 520 }, area)).toEqual({ x: 0, y: 25, width: 420, height: 520 });
  });

  it("shrinks a window that is larger than the area", () => {
    expect(fitInto({ x: -50, y: -50, width: 2000, height: 1200 }, area)).toEqual(area);
  });

  it("works on a second monitor with an offset", () => {
    const right = { x: 1440, y: 0, width: 1920, height: 1080 };
    expect(fitInto({ x: 3200, y: 900, width: 420, height: 520 }, right)).toEqual({ x: 2940, y: 560, width: 420, height: 520 });
  });
});
