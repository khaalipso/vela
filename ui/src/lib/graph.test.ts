import { describe, expect, it } from "vitest";
import { COL, shapes } from "./graph";

describe("graph shapes", () => {
  it("a straight line of commits joins dot to dot, open at both ends only inside", () => {
    const s = shapes(["*", "*", "*"], [26, 26, 26]);
    expect(s[0].segs).toEqual([{ x1: COL / 2, y1: 13, x2: COL / 2, y2: 26, color: expect.any(String) }]);
    expect(s[1].segs).toHaveLength(2);
    expect(s[2].segs).toEqual([{ x1: COL / 2, y1: 0, x2: COL / 2, y2: 13, color: expect.any(String) }]);
    expect(s.every((r) => r.dot)).toBe(true);
  });
  it("a merge draws its branch lane and joins it back", () => {
    const rows = ["*", "|\\", "| *", "|/", "*"];
    const s = shapes(rows, rows.map((r) => (r.includes("*") ? 26 : 14)));
    // the diagonal of "|\" goes from lane 0 to lane 1
    expect(s[1].segs.some((g) => g.x1 === COL / 2 && g.x2 === 2 * COL + COL / 2)).toBe(true);
    // the side commit is reached from above and goes on below
    expect(s[2].segs.filter((g) => g.x1 === 2 * COL + COL / 2)).toHaveLength(2);
    expect(s[0].width).toBe(3 * COL);
  });
});
