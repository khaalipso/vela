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

/** Pin or unpin one tab. A second preview tab cannot exist: the others stay as they are. */
export function setPinned(tabs: Tab[], key: string, pinned: boolean): Tab[] {
  return tabs.map((t) => (t.key === key ? { ...t, pinned } : t));
}

/** Keep only `key`. */
export function closeOthers(tabs: Tab[], key: string): Tab[] {
  return tabs.filter((t) => t.key === key);
}

/** Close every tab after `key`. */
export function closeToRight(tabs: Tab[], key: string): Tab[] {
  const at = tabs.findIndex((t) => t.key === key);
  return at < 0 ? tabs : tabs.slice(0, at + 1);
}

/** The tab to show after closing some: keep `current` when it survived, else `fallback` (or the last tab). */
export function currentAfter(tabs: Tab[], current: string, fallback: string): string {
  if (tabs.some((t) => t.key === current)) return current;
  if (tabs.some((t) => t.key === fallback)) return fallback;
  return tabs[tabs.length - 1]?.key ?? "";
}

/** A file or folder was renamed: every key at or below `from` moves to `to`. */
export function renameKeys(keys: string[], from: string, to: string): string[] {
  return keys.map((k) => (k === from ? to : k.startsWith(`${from}/`) ? to + k.slice(from.length) : k));
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

/**
 * The short label of each tab: the file name alone, with its parent folder in front only when
 * two open files share the name (and the next folder up while they still do).
 */
export function tabLabels(keys: string[]): Map<string, string> {
  const parts = (k: string) => k.slice(k.indexOf("/") + 1).split("/");
  const depth = new Map(keys.map((k) => [k, 1]));
  const label = (k: string) => parts(k).slice(-depth.get(k)!).join("/");
  for (let guard = 0; guard < 8; guard++) {
    const by = new Map<string, string[]>();
    for (const k of keys) by.set(label(k), [...(by.get(label(k)) ?? []), k]);
    let grew = false;
    for (const same of by.values()) {
      if (same.length < 2) continue;
      for (const k of same) if (depth.get(k)! < parts(k).length) (depth.set(k, depth.get(k)! + 1), (grew = true));
    }
    if (!grew) break;
  }
  return new Map(keys.map((k) => [k, label(k)]));
}

/** The tab to give up when the tabs do not fit on two lines: the oldest one that is not shown. */
export function oldestToDrop(tabs: Tab[], current: string): string | null {
  return tabs.find((t) => t.key !== current)?.key ?? null;
}
