// A hunk as unified diff text, for "Copy hunk as patch". The paths are relative to the repo root.

import type { Hunk } from "./types";

const PREFIX = { context: " ", add: "+", del: "-" } as const;

export function hunkPatch(h: Hunk): string {
  const range = (start: number, n: number) => (n === 1 ? `${start}` : `${start},${n}`);
  const head = `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@${h.section ? ` ${h.section}` : ""}`;
  const body = h.lines.map((l) => `${PREFIX[l.kind]}${l.text}`);
  return [`--- a/${h.path}`, `+++ b/${h.path}`, head, ...body].join("\n") + "\n";
}
