// Repo colors: each repo of a space gets a soft color in the family of the space color
// (analogous hues around it), so the repos of one space read as a set and never clash.

import type { Space } from "./types";

export function hexToHsl(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xe8a14a;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s * 100, l * 100];
}

export function hslToHex(h: number, s: number, l: number): string {
  const hh = (((h % 360) + 360) % 360) / 360;
  const ss = Math.max(0, Math.min(100, s)) / 100;
  const ll = Math.max(0, Math.min(100, l)) / 100;
  const f = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
    const p = 2 * ll - q;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const to = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(f(hh + 1 / 3))}${to(f(hh))}${to(f(hh - 1 / 3))}`.toUpperCase();
}

/** Hue steps around the space hue: 0, +32, -32, +64, -64, ... */
export function hueOffset(i: number): number {
  if (i <= 0) return 0;
  const step = Math.ceil(i / 2) * 32;
  return i % 2 ? step : -step;
}

/**
 * The color of the repo at `index` in a space of color `spaceColor`: an analogous hue, a
 * calm saturation (40 to 58%) and a mid lightness that reads on dark and light panels.
 */
export function repoColor(spaceColor: string, index: number): string {
  const [h, s] = hexToHsl(spaceColor);
  const sat = s < 8 ? 10 : Math.max(40, Math.min(58, s * 0.75));
  // Small lightness steps keep neighbours apart when the hues are close.
  const light = 64 + (index % 3) * 3 - (index % 2) * 4;
  return hslToHex(h + hueOffset(index), sat, light);
}

/** The color of a repo of a space by name; the space color when the repo is not in it. */
export function colorOfRepo(space: Pick<Space, "color" | "repos">, repo: string): string {
  const i = space.repos.findIndex((r) => r.name === repo);
  return repoColor(space.color, Math.max(0, i));
}
