// Tabs of the code view and the list of recently opened files, as plain functions.
// A click in the file tree opens a preview tab (italic, replaced by the next preview);
// a double click pins it.

export interface Tab {
  /** `repo/path`, see `fileKey`. */
  key: string;
  pinned: boolean;
}

/** Open `key`: reuse its tab, or take the place of the preview tab, or append a new one. */
export function openTab(tabs: Tab[], key: string, pin: boolean): Tab[] {
  const at = tabs.findIndex((t) => t.key === key);
  if (at >= 0) return pin && !tabs[at].pinned ? tabs.map((t, i) => (i === at ? { ...t, pinned: true } : t)) : tabs;
  const tab = { key, pinned: pin };
  const preview = pin ? -1 : tabs.findIndex((t) => !t.pinned);
  if (preview >= 0) return tabs.map((t, i) => (i === preview ? tab : t));
  return [...tabs, tab];
}

/** Close a tab; returns the tabs and the key to show next (the neighbour) when it was `current`. */
export function closeTab(tabs: Tab[], key: string, current: string): { tabs: Tab[]; current: string } {
  const at = tabs.findIndex((t) => t.key === key);
  if (at < 0) return { tabs, current };
  const next = tabs.filter((t) => t.key !== key);
  if (current !== key) return { tabs: next, current };
  return { tabs: next, current: next[Math.min(at, next.length - 1)]?.key ?? "" };
}

/** Most recent first, no duplicates. */
export function pushRecent(list: string[], key: string, max = 30): string[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, max);
}

const recentKey = (spaceId: string) => `vela.recent.${spaceId}`;

export function loadRecent(spaceId: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(recentKey(spaceId)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 30) : [];
  } catch {
    return [];
  }
}

export function saveRecent(spaceId: string, list: string[]) {
  try {
    localStorage.setItem(recentKey(spaceId), JSON.stringify(list));
  } catch {
    /* private window or blocked storage: recents just are not kept */
  }
}
