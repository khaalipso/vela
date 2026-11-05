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

/** Where you were, most recent first: the place you are in is always the first. */
export interface NavHist {
  stack: Place[];
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

export const emptyHist = (): NavHist => ({ stack: [] });

/** A place you reach goes to the front, wherever it was before (like the tabs of a browser or Alt Tab). */
export function record(h: NavHist, p: Place, max = 100): NavHist {
  if (h.stack.length && placeKey(h.stack[0]) === placeKey(p)) return h;
  const k = placeKey(p);
  return { stack: [p, ...h.stack.filter((x) => placeKey(x) !== k)].slice(0, max) };
}

/**
 * Go to an older place (-1: the one just behind the current one, so twice brings you back to
 * where you started) or, with +1, bring the oldest one forward. The place reached goes to the
 * front. `null` when there is nowhere to go.
 */
export function step(h: NavHist, delta: 1 | -1): { hist: NavHist; place: Place } | null {
  if (h.stack.length < 2) return null;
  const place = delta < 0 ? h.stack[1] : h.stack[h.stack.length - 1];
  return { hist: record(h, place), place };
}
