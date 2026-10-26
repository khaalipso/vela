// Fuzzy subsequence matching on relative paths, tuned for file names.
//
// A query matches when its characters appear in order in the path (case-insensitive).
// The score rewards what people mean when they type a few letters of a path:
//   - consecutive characters,
//   - characters in the basename (after the last `/`),
//   - the start of a path component, a word after `_ - . space`, a camelCase hump,
//   - shorter paths win ties.
// The best alignment is found with a small dynamic program, so "wh" prefers `webhook.ts`
// over a path that merely contains `w` and `h` somewhere.

export interface Hit {
  /** Index in the list the index was built from. */
  index: number;
  score: number;
  /** Indices of the matched characters in the path. */
  positions: number[];
}

const MATCH = 16;
const CONSECUTIVE = 12;
const GAP = 1;
const B_SLASH = 10;
const B_WORD = 8;
const B_CAMEL = 7;
const B_BASENAME = 6;
const NEG = -1e9;

const isLower = (c: number) => c >= 97 && c <= 122;
const isUpper = (c: number) => c >= 65 && c <= 90;

/** Bonus for matching the character at `j`, from what precedes it. */
function bonusAt(path: string, j: number, baseStart: number): number {
  let b = 0;
  if (j === 0) b = B_SLASH;
  else {
    const prev = path.charCodeAt(j - 1);
    if (prev === 47) b = B_SLASH;
    else if (prev === 95 || prev === 45 || prev === 46 || prev === 32) b = B_WORD;
    else if (isLower(prev) && isUpper(path.charCodeAt(j))) b = B_CAMEL;
  }
  return j >= baseStart ? b + B_BASENAME : b;
}

/** Cheap test: are the characters of `q` in `lower` in order? */
function isSubsequence(q: string, lower: string): boolean {
  let at = -1;
  for (let i = 0; i < q.length; i++) {
    at = lower.indexOf(q[i], at + 1);
    if (at < 0) return false;
  }
  return true;
}

/** Scratch buffer shared by all calls (the matrix of the dynamic program). */
let matrix = new Float64Array(4096);

/** Fill the matrix; returns [bestScore, lastColumn] or null. `m` rows, `n` columns. */
function fill(q: string, path: string, lower: string, baseStart: number): number {
  const m = q.length;
  const n = path.length;
  if (matrix.length < m * n) matrix = new Float64Array(m * n * 2);
  const M = matrix;
  let best = NEG;
  for (let i = 0; i < m; i++) {
    const qc = q.charCodeAt(i);
    const row = i * n;
    const prevRow = row - n;
    let gapBest = NEG;
    const last = n - (m - i); // leave room for the remaining characters
    for (let j = 0; j < i; j++) M[row + j] = NEG;
    for (let j = i; j <= last; j++) {
      if (i > 0) {
        gapBest -= GAP;
        if (j >= i + 1) {
          const cand = M[prevRow + j - 2] - GAP;
          if (cand > gapBest) gapBest = cand;
        }
      }
      if (lower.charCodeAt(j) !== qc) {
        M[row + j] = NEG;
        continue;
      }
      let s: number;
      if (i === 0) s = 0;
      else {
        const diag = M[prevRow + j - 1];
        s = diag > NEG / 2 ? diag + CONSECUTIVE : NEG;
        if (gapBest > s) s = gapBest;
        if (s <= NEG / 2) {
          M[row + j] = NEG;
          continue;
        }
      }
      s += MATCH + bonusAt(path, j, baseStart);
      M[row + j] = s;
      if (i === m - 1 && s > best) best = s;
    }
    for (let j = last + 1; j < n; j++) M[row + j] = NEG;
  }
  return best;
}

/** Extra points for the whole query hitting the basename. */
function basenameExtra(q: string, lower: string, baseStart: number): number {
  const base = lower.slice(baseStart);
  if (base === q) return 40;
  if (base.startsWith(q)) return 20;
  const dot = base.lastIndexOf(".");
  if (dot > 0 && base.slice(0, dot) === q) return 30;
  return 0;
}

function finalScore(raw: number, q: string, lower: string, len: number, baseStart: number): number {
  // Shorter paths win ties; the penalty stays below one point.
  return raw + basenameExtra(q, lower, baseStart) - Math.min(len, 99) * 0.01;
}

/** Walk the matrix back from the best last cell. */
function backtrack(q: string, n: number): number[] {
  const m = q.length;
  const M = matrix;
  let j = -1;
  let best = NEG;
  for (let c = 0; c < n; c++) {
    const v = M[(m - 1) * n + c];
    if (v > best) {
      best = v;
      j = c;
    }
  }
  const pos = new Array<number>(m);
  pos[m - 1] = j;
  for (let i = m - 2; i >= 0; i--) {
    let bk = -1;
    let bv = NEG;
    for (let k = j - 1; k >= i; k--) {
      const v = M[i * n + k];
      if (v <= NEG / 2) continue;
      const w = v + (k === j - 1 ? CONSECUTIVE : -GAP * (j - 1 - k));
      if (w > bv) {
        bv = w;
        bk = k;
      }
    }
    j = bk;
    pos[i] = j;
  }
  return pos;
}

/** Match one path. `q` must be lowercase. Returns null when it does not match. */
export function fuzzyMatch(q: string, path: string): { score: number; positions: number[] } | null {
  if (!q) return { score: 0, positions: [] };
  let lower = path.toLowerCase();
  if (lower.length !== path.length) lower = path;
  if (q.length > path.length || !isSubsequence(q, lower)) return null;
  const baseStart = path.lastIndexOf("/") + 1;
  const raw = fill(q, path, lower, baseStart);
  if (raw <= NEG / 2) return null;
  return { score: finalScore(raw, q, lower, path.length, baseStart), positions: backtrack(q, path.length) };
}

/** Order of results: best score first, then the shorter path, then the original order. */
function byRank(paths: string[]) {
  return (a: { index: number; score: number }, b: { index: number; score: number }) =>
    b.score - a.score || paths[a.index].length - paths[b.index].length || a.index - b.index;
}

/** A list of paths prepared for fast repeated searching. */
export class FileIndex {
  readonly paths: string[];
  private readonly lower: string[];
  private readonly base: Int32Array;

  constructor(paths: string[]) {
    this.paths = paths;
    this.lower = new Array<string>(paths.length);
    this.base = new Int32Array(paths.length);
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const l = p.toLowerCase();
      this.lower[i] = l.length === p.length ? l : p;
      this.base[i] = p.lastIndexOf("/") + 1;
    }
  }

  get size(): number {
    return this.paths.length;
  }

  /** Best `limit` matches of `query` (case-insensitive), with the matched positions. */
  search(query: string, limit = 2000): Hit[] {
    const q = query.trim().toLowerCase().replace(/\s+/g, "");
    if (!q) return [];
    const { paths, lower, base } = this;
    const idx: number[] = [];
    const sc: number[] = [];
    for (let i = 0; i < paths.length; i++) {
      const l = lower[i];
      if (q.length > l.length || !isSubsequence(q, l)) continue;
      const raw = fill(q, paths[i], l, base[i]);
      if (raw <= NEG / 2) continue;
      idx.push(i);
      sc.push(finalScore(raw, q, l, l.length, base[i]));
    }
    let cands: { index: number; score: number }[];
    if (idx.length > limit * 2) {
      // Keep only the top scores before sorting: a histogram finds the cut-off.
      let lo = Infinity;
      let hi = -Infinity;
      for (const s of sc) {
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
      const BINS = 512;
      const w = (hi - lo) / BINS || 1;
      const counts = new Uint32Array(BINS + 1);
      for (const s of sc) counts[Math.floor((s - lo) / w)]++;
      let acc = 0;
      let cut = BINS;
      for (; cut > 0; cut--) {
        acc += counts[cut];
        if (acc >= limit) break;
      }
      const min = lo + cut * w;
      cands = [];
      for (let k = 0; k < idx.length; k++) if (sc[k] >= min) cands.push({ index: idx[k], score: sc[k] });
    } else {
      cands = idx.map((index, k) => ({ index, score: sc[k] }));
    }
    cands.sort(byRank(paths));
    if (cands.length > limit) cands.length = limit;
    return cands.map((c) => {
      // Recompute for the positions of the shown results only.
      const p = paths[c.index];
      fill(q, p, lower[c.index], base[c.index]);
      return { index: c.index, score: c.score, positions: backtrack(q, p.length) };
    });
  }
}
