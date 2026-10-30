// Back and forward through where you were, as in a browser: one history per space, over views,
// files and agents. Pure; the shell records and restores locations.

export interface Place {
  view: string;
  /** Open file (code view). */
  file: string;
  /** Selected agent (agents view). */
  agent: string;
  /** Selected file row (review view). */
  row: string;
}

export interface NavHist {
  stack: Place[];
  at: number;
}

export const placeKey = (p: Place): string => `${p.view}|${p.file}|${p.agent}|${p.row}`;

/** What the view makes the place of: only the part that view shows counts. */
export function placeOf(view: string, file: string, agent: string, row: string): Place {
  return {
    view,
    file: view === "code" ? file : "",
    agent: view === "agents" ? agent : "",
    row: view === "review" ? row : "",
  };
}

export const emptyHist = (): NavHist => ({ stack: [], at: -1 });

/** A new place after the current one drops the forward part. Same place twice is one. */
export function record(h: NavHist, p: Place, max = 100): NavHist {
  if (h.at >= 0 && placeKey(h.stack[h.at]) === placeKey(p)) return h;
  const stack = [...h.stack.slice(0, h.at + 1), p].slice(-max);
  return { stack, at: stack.length - 1 };
}

export const canBack = (h: NavHist) => h.at > 0;
export const canForward = (h: NavHist) => h.at >= 0 && h.at < h.stack.length - 1;

/** Move by `delta` places; `null` when there is nowhere to go. */
export function step(h: NavHist, delta: 1 | -1): { hist: NavHist; place: Place } | null {
  const at = h.at + delta;
  if (at < 0 || at >= h.stack.length) return null;
  return { hist: { ...h, at }, place: h.stack[at] };
}
