// Conflict markers left by a three-way merge (`<<<<<<< yours` … `=======` … `>>>>>>> agent`):
// find them and resolve them one by one or all at once. Pure text in, text out.

export type Side = "mine" | "theirs" | "both";

export interface Conflict {
  /** Offsets of the whole block, markers included (`to` is after the last newline). */
  from: number;
  to: number;
  /** 1-based line of the opening marker. */
  line: number;
  mine: string;
  theirs: string;
}

const OPEN = /^<<<<<<< ?(.*)$/;
const BASE = /^\|\|\|\|\|\|\| ?(.*)$/;
const SEP = /^=======$/;
const CLOSE = /^>>>>>>> ?(.*)$/;

/** Every complete conflict block of the text, in order. */
export function findConflicts(text: string): Conflict[] {
  const out: Conflict[] = [];
  let pos = 0;
  let line = 0;
  let cur: { from: number; line: number; mine: string[]; theirs: string[]; part: "mine" | "base" | "theirs" } | null = null;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl < 0 ? text.length : nl + 1;
    const l = text.slice(pos, nl < 0 ? text.length : nl);
    line++;
    if (OPEN.test(l)) {
      cur = { from: pos, line, mine: [], theirs: [], part: "mine" };
    } else if (cur && cur.part === "mine" && BASE.test(l)) {
      cur.part = "base";
    } else if (cur && cur.part !== "theirs" && SEP.test(l)) {
      cur.part = "theirs";
    } else if (cur && cur.part === "theirs" && CLOSE.test(l)) {
      out.push({ from: cur.from, to: end, line: cur.line, mine: join(cur.mine), theirs: join(cur.theirs) });
      cur = null;
    } else if (cur && cur.part === "mine") {
      cur.mine.push(l);
    } else if (cur && cur.part === "theirs") {
      cur.theirs.push(l);
    }
    if (nl < 0) break;
    pos = end;
  }
  return out;
}

const join = (lines: string[]) => (lines.length ? lines.join("\n") + "\n" : "");

/** The text that replaces a conflict when one side is kept. */
export function pick(c: Conflict, side: Side): string {
  if (side === "mine") return c.mine;
  if (side === "theirs") return c.theirs;
  return c.mine + c.theirs;
}

/** Resolve one conflict (by index) or all of them with the same side. */
export function resolve(text: string, side: Side, index?: number): string {
  const all = findConflicts(text);
  let out = text;
  for (let i = all.length - 1; i >= 0; i--) {
    if (index !== undefined && i !== index) continue;
    const c = all[i];
    out = out.slice(0, c.from) + pick(c, side) + out.slice(c.to);
  }
  return out;
}
