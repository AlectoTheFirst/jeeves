export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Move and, if necessary, shrink `win` so that it is fully in `area`.
 * Returns the same values when the window already fits.
 */
export function fitInto(win: Rect, area: Rect): Rect {
  const width = Math.min(win.width, area.width);
  const height = Math.min(win.height, area.height);
  const x = Math.min(Math.max(win.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(win.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
