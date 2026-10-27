import { describe, expect, it } from "vitest";
import { colorOfRepo, hexToHsl, hslToHex, hueOffset, repoColor } from "./colors";

describe("repo colors", () => {
  it("round trips hex and hsl", () => {
    for (const c of ["#E8A14A", "#7DB8F5", "#C9A0F0", "#000000", "#FFFFFF"]) {
      const [h, s, l] = hexToHsl(c);
      expect(hslToHex(h, s, l)).toBe(c);
    }
  });

  it("spreads hues around the space hue", () => {
    expect([0, 1, 2, 3, 4].map(hueOffset)).toEqual([0, 32, -32, 64, -64]);
  });

  it("gives each repo a distinct, soft color in the family of the space", () => {
    const space = "#E8A14A";
    const [h0] = hexToHsl(space);
    const colors = [0, 1, 2, 3].map((i) => repoColor(space, i));
    expect(new Set(colors).size).toBe(4);
    for (const [i, c] of colors.entries()) {
      const [h, s, l] = hexToHsl(c);
      const dh = Math.abs(((h - h0 - hueOffset(i) + 540) % 360) - 180);
      expect(dh).toBeLessThan(2);
      expect(s).toBeGreaterThanOrEqual(39);
      expect(s).toBeLessThanOrEqual(59);
      expect(l).toBeGreaterThan(55);
      expect(l).toBeLessThan(72);
    }
  });

  it("is stable: the same space and repo always give the same color", () => {
    const sp = { color: "#7DB8F5", repos: [{ name: "api" }, { name: "web" }] } as never;
    expect(colorOfRepo(sp, "web")).toBe(colorOfRepo(sp, "web"));
    expect(colorOfRepo(sp, "web")).not.toBe(colorOfRepo(sp, "api"));
  });
});
