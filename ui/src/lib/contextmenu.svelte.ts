// The right-click menu: the store (one menu open at a time) and the pure parts, which are
// tested headless: placement inside the viewport, which entry the arrows and letters reach.

import type { IconName } from "./menuicons";

/** One line of a menu. */
export interface MenuAction {
  id: string;
  label: string;
  /** The key that does the same thing, as written in the UI (`Y`, `Shift A`). */
  shortcut?: string;
  icon?: IconName;
  danger?: boolean;
  /** A string says why the item cannot be used now (shown as a tooltip); `true` gives no reason. */
  disabled?: string | boolean;
  run?: () => void;
  /** One level of submenu. */
  submenu?: MenuEntry[];
  /** Radio style mark, for the current choice in a submenu. */
  checked?: boolean;
  /** A color dot before the label (the space colors). */
  swatch?: string;
  /** False keeps the item out of the command bar, which already has it. */
  palette?: boolean;
}

export interface MenuSeparator {
  separator: true;
}

export type MenuEntry = MenuAction | MenuSeparator;

export const SEP: MenuSeparator = { separator: true };

export const isItem = (e: MenuEntry): e is MenuAction => !("separator" in e);

/** Drop separators at the ends and doubled ones, so builders can add them freely. */
export function tidy(entries: (MenuEntry | false | null | undefined)[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (!isItem(e) && (out.length === 0 || !isItem(out[out.length - 1]))) continue;
    out.push(e);
  }
  while (out.length && !isItem(out[out.length - 1])) out.pop();
  return out;
}

/** Labels of the items, separators as "-" (what tests and the command bar read). */
export function labels(entries: MenuEntry[]): string[] {
  return entries.map((e) => (isItem(e) ? e.label : "-"));
}

export const isDisabled = (e: MenuAction): boolean => !!e.disabled;

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export const MARGIN = 8;

/** Top left corner of a menu of `w` by `h` opened at (x, y), moved to stay inside the viewport. */
export function clampToViewport(x: number, y: number, w: number, h: number, vw: number, vh: number, margin = MARGIN): { x: number; y: number } {
  const maxX = Math.max(margin, vw - w - margin);
  const maxY = Math.max(margin, vh - h - margin);
  return { x: Math.min(Math.max(margin, x), maxX), y: Math.min(Math.max(margin, y), maxY) };
}

/** Where a submenu goes: to the right of its parent item, to the left when that would not fit. */
export function placeSubmenu(
  item: { left: number; right: number; top: number },
  w: number,
  h: number,
  vw: number,
  vh: number,
  margin = MARGIN,
): { x: number; y: number; flipped: boolean } {
  const right = item.right - 4;
  const flipped = right + w > vw - margin && item.left - w + 4 >= margin;
  const x = flipped ? item.left - w + 4 : right;
  const y = Math.min(Math.max(margin, item.top - 4), Math.max(margin, vh - h - margin));
  return { x: Math.min(x, Math.max(margin, vw - w - margin)), y, flipped };
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/** The next item in the direction of `delta` from `from` (-1 for none), wrapping, skipping separators. */
export function nextIndex(entries: MenuEntry[], from: number, delta: 1 | -1): number {
  const n = entries.length;
  if (!entries.some(isItem)) return -1;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = from < 0 && delta === -1 && step === 0 ? n - 1 : (i + delta + n) % n;
    if (isItem(entries[i])) return i;
  }
  return -1;
}

export const firstIndex = (entries: MenuEntry[]): number => nextIndex(entries, -1, 1);
export const lastIndex = (entries: MenuEntry[]): number => nextIndex(entries, entries.length, -1);

/** The next item whose label starts with `ch` after `from`, wrapping; -1 when none does. */
export function letterIndex(entries: MenuEntry[], from: number, ch: string): number {
  const c = ch.toLowerCase();
  const n = entries.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step + n) % n;
    const e = entries[i];
    if (isItem(e) && e.label.trim().toLowerCase().startsWith(c)) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface OpenMenu {
  entries: MenuEntry[];
  x: number;
  y: number;
  /** Opened from the keyboard: the first item is already under the cursor. */
  keyboard: boolean;
  /** Where focus returns when the menu closes. */
  invoker: HTMLElement | null;
  label: string;
}

export interface OpenAt {
  x: number;
  y: number;
  keyboard?: boolean;
  invoker?: HTMLElement | null;
  /** Accessible name of the menu. */
  label?: string;
}

class MenuStore {
  current = $state.raw<OpenMenu | null>(null);

  /** Open a menu (replacing any open one). Empty menus are not shown. */
  open(entries: MenuEntry[], at: OpenAt) {
    const list = tidy(entries);
    if (!list.some(isItem)) return;
    const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    const invoker = at.invoker ?? (this.current?.invoker ?? (active && active !== document.body ? active : null));
    this.current = { entries: list, x: at.x, y: at.y, keyboard: !!at.keyboard, invoker, label: at.label ?? "Actions" };
  }

  /** Close the menu. Focus goes back to the element that had it, unless `restore` is false. */
  close(restore = true) {
    const m = this.current;
    if (!m) return;
    this.current = null;
    if (restore && m.invoker?.isConnected) m.invoker.focus({ preventScroll: true });
  }

  get isOpen(): boolean {
    return this.current !== null;
  }
}

export const menu = new MenuStore();

/** Open the menu at the pointer of a `contextmenu` event and stop the browser's own menu. */
export function openAtEvent(e: MouseEvent, entries: MenuEntry[], label?: string) {
  e.preventDefault();
  menu.open(entries, { x: e.clientX, y: e.clientY, keyboard: isKeyboardEvent(e), label });
}

/** The synthetic `contextmenu` events made for the Menu key carry this marker. */
const KEYBOARD = Symbol("keyboard-contextmenu");

export function isKeyboardEvent(e: Event): boolean {
  return !!(e as unknown as Record<symbol, boolean>)[KEYBOARD];
}

/** Fire a `contextmenu` event at an element from the keyboard, at the element itself. */
export function contextMenuAt(el: Element, at?: { x: number; y: number }): boolean {
  const r = el.getBoundingClientRect();
  const ev = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: at?.x ?? r.left + Math.min(24, r.width / 2),
    clientY: at?.y ?? r.bottom,
  });
  (ev as unknown as Record<symbol, boolean>)[KEYBOARD] = true;
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}
