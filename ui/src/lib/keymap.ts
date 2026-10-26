export type View = "code" | "review" | "agents";
export type Overlay = "palette" | "newspace" | "commit" | "composer" | "help" | null;

/** Everything that can happen in the shell. Keys, buttons and the command bar all produce these. */
export type Action =
  | { type: "palette-toggle" }
  | { type: "palette-move"; delta: 1 | -1 }
  | { type: "palette-run" }
  | { type: "close" } // close overlay / stack popover
  | { type: "blur" } // leave the text field or editor
  | { type: "newspace-submit" }
  | { type: "commit-submit" }
  | { type: "composer-role"; delta: 1 | -1 }
  | { type: "composer-send" }
  | { type: "up-next" }
  | { type: "next-waiting" }
  | { type: "view"; view: View }
  | { type: "space-prev" }
  | { type: "space-next" }
  | { type: "space-jump"; index: number }
  | { type: "move"; delta: 1 | -1 }
  | { type: "accept" }
  | { type: "reject" }
  | { type: "edit" }
  | { type: "undo" }
  | { type: "fix" }
  | { type: "answer"; yes: boolean }
  | { type: "toggle-changes" }
  | { type: "toggle-stack" }
  | { type: "open-stack" }
  | { type: "open-commit" }
  | { type: "toggle-window" }
  | { type: "open-composer" }
  | { type: "open-newspace" }
  | { type: "open-palette" }
  | { type: "open-help" }
  | { type: "open-file"; space: number; file: string };

/** The part of a KeyboardEvent the resolver reads. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface KeyContext {
  /** Focus is in an input, a textarea or the editor. */
  typing: boolean;
  overlay: Overlay;
  stackOpen: boolean;
  view: View;
  /** The current space has an open agent question. */
  hasQuestion: boolean;
}

/** The part of an element `isTyping` reads. */
export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** Is focus in a text field or in the editor? Single letters must not act then. */
export function isTyping(t: TargetLike | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // CodeMirror's content element, or any contenteditable ancestor, for engines without isContentEditable.
  return !!t.closest?.('[contenteditable]:not([contenteditable="false"])');
}

/**
 * Pure key resolution. Returns the action to run (the caller prevents the default
 * browser behaviour) or null when the key is not ours.
 * Single letters never act while typing; Escape leaves the field first.
 */
export function resolveKey(e: KeyLike, c: KeyContext): Action | null {
  const k = e.key;
  const ctrl = !!(e.ctrlKey || e.metaKey);
  const alt = !!e.altKey;
  const shift = !!e.shiftKey;

  if (ctrl && (k === "k" || k === "K")) return { type: "palette-toggle" };

  if (k === "Escape") {
    if (c.overlay || c.stackOpen) return { type: "close" };
    if (c.typing) return { type: "blur" };
    return null;
  }

  if (c.overlay === "palette") {
    if (k === "ArrowDown") return { type: "palette-move", delta: 1 };
    if (k === "ArrowUp") return { type: "palette-move", delta: -1 };
    if (k === "Enter") return { type: "palette-run" };
    return null;
  }
  if (c.overlay === "newspace") return k === "Enter" && ctrl ? { type: "newspace-submit" } : null;
  if (c.overlay === "commit") return k === "Enter" && ctrl ? { type: "commit-submit" } : null;
  if (c.overlay === "composer") {
    if (k === "Tab") return { type: "composer-role", delta: shift ? -1 : 1 };
    if (k === "Enter" && !shift) return { type: "composer-send" };
    return null;
  }
  if (c.overlay === "help") return k === "?" ? { type: "close" } : null;

  if (c.typing) return null;

  if (alt && !ctrl) {
    const m = /^[1-9]$/.test(k) ? k : /^Digit([1-9])$/.exec(e.code ?? "")?.[1];
    if (m) return { type: "space-jump", index: Number(m) - 1 };
  }
  if (ctrl || alt) return null;

  switch (k) {
    case "Enter":
      return shift ? { type: "next-waiting" } : { type: "up-next" };
    case "1":
      return { type: "view", view: "code" };
    case "2":
      return { type: "view", view: "review" };
    case "3":
      return { type: "view", view: "agents" };
    case "[":
      return { type: "space-prev" };
    case "]":
      return { type: "space-next" };
    case "j":
    case "J":
    case "ArrowDown":
      return c.view === "agents" ? null : { type: "move", delta: 1 };
    case "k":
    case "K":
    case "ArrowUp":
      return c.view === "agents" ? null : { type: "move", delta: -1 };
    case "y":
    case "Y":
      return c.view === "agents" && c.hasQuestion ? { type: "answer", yes: true } : { type: "accept" };
    case "n":
    case "N":
      return c.view === "agents" && c.hasQuestion ? { type: "answer", yes: false } : { type: "reject" };
    case "e":
    case "E":
      return { type: "edit" };
    case "f":
    case "F":
      return { type: "fix" };
    case "u":
    case "U":
      return { type: "undo" };
    case "b":
    case "B":
      return { type: "toggle-changes" };
    case "s":
    case "S":
      return { type: "toggle-stack" };
    case "c":
    case "C":
      return { type: "open-commit" };
    case "w":
    case "W":
      return { type: "toggle-window" };
    case "@":
      return { type: "open-composer" };
    case "?":
      return { type: "open-help" };
    default:
      return null;
  }
}
