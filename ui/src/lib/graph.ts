// The drawing of `git log --graph` as shapes: each row becomes lines and a dot that join the
// rows above and below, so the lanes read as one tree. Pure, tested headless.

export const COL = 7; // px per character of the drawing
export const LANES = ["var(--space)", "var(--info)", "var(--add)", "var(--warn)", "var(--del)", "var(--syn-fn, var(--info))"];

export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}
export interface Shape {
  width: number;
  segs: Seg[];
  dot: { x: number; color: string } | null;
}

const laneColor = (i: number) => LANES[Math.floor(i / 2) % LANES.length];
const xOf = (i: number) => i * COL + COL / 2;
const at = (row: string | undefined, i: number) => (row && i >= 0 && i < row.length ? row[i] : " ");

/** Does the row above end on column `i`? */
function fromAbove(prev: string | undefined, i: number): boolean {
  const c = at(prev, i);
  return c === "|" || c === "*" || at(prev, i + 1) === "/" || at(prev, i - 1) === "\\";
}
/** Does the row below start on column `i`? */
function toBelow(next: string | undefined, i: number): boolean {
  const c = at(next, i);
  return c === "|" || c === "*" || at(next, i - 1) === "/" || at(next, i + 1) === "\\";
}

/** Shapes of every row, in `h` px tall rows (each row has its own height). */
export function shapes(rows: string[], heights: number[]): Shape[] {
  const width = Math.max(1, ...rows.map((r) => r.length)) * COL;
  return rows.map((row, k) => {
    const h = heights[k];
    const mid = h / 2;
    const prev = rows[k - 1];
    const next = rows[k + 1];
    const segs: Seg[] = [];
    let dot: Shape["dot"] = null;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      const x = xOf(i);
      const color = laneColor(i);
      if (ch === "|") segs.push({ x1: x, y1: 0, x2: x, y2: h, color });
      else if (ch === "/") segs.push({ x1: xOf(i + 1), y1: 0, x2: xOf(i - 1), y2: h, color: laneColor(i - 1) });
      else if (ch === "\\") segs.push({ x1: xOf(i - 1), y1: 0, x2: xOf(i + 1), y2: h, color: laneColor(i + 1) });
      else if (ch === "_") segs.push({ x1: x - COL / 2, y1: h, x2: x + COL / 2, y2: h, color });
      else if (ch === "*") {
        if (fromAbove(prev, i)) segs.push({ x1: x, y1: 0, x2: x, y2: mid, color });
        if (toBelow(next, i)) segs.push({ x1: x, y1: mid, x2: x, y2: h, color });
        dot = { x, color };
      }
    }
    return { width, segs, dot };
  });
}
