export type View = "code" | "review" | "agents";
export type Overlay = "palette" | "quickopen" | "newspace" | "commit" | "composer" | "links" | "help" | null;

/** Everything that can happen in the shell. Keys, buttons and the command bar all produce these. */
export type Action =
  | { type: "palette-toggle" }
  | { type: "palette-move"; delta: 1 | -1 }
  | { type: "palette-run" }
  | { type: "close" } // close overlay / stack popover
  | { type: "blur" } // leave the text field or editor
  | { type: "newspace-submit" }
  | { type: "commit-submit" }
  // commit composer (overlay "commit")
  | { type: "cc-type" } // cycle the type of the focused commit
  | { type: "cc-breaking" } // toggle breaking
  | { type: "cc-hunk"; delta: 1 | -1 } // select a hunk of the focused commit
  | { type: "cc-group"; delta: 1 | -1 } // focus the next / previous commit
  | { type: "cc-move"; to: number } // move the selected hunk to commit number `to` (1 based)
  | { type: "cc-split" } // selected hunk becomes a new commit
  | { type: "cc-merge" } // everything in one commit per repo
  | { type: "cc-edit" } // jump into the subject field
  | { type: "cc-conventional" } // conventional commits on / off
  // links sheet (overlay "links")
  | { type: "links-move"; delta: 1 | -1 }
  | { type: "links-open" }
  | { type: "links-submit" } // Enter in the URL field: add it, or open the selected link when empty
  | { type: "links-remove" }
  | { type: "open-link"; id: string }
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
  | { type: "toggle-files" }
  | { type: "quick-open" } // Ctrl P: go to file
  | { type: "files-filter" } // / : jump into the filter field of the file tree
  | { type: "toggle-stack" }
  | { type: "open-stack" }
  | { type: "open-commit" }
  | { type: "open-links" }
  | { type: "toggle-window" }
  | { type: "open-composer" }
  | { type: "open-newspace" }
  | { type: "open-newrepo" }
  | { type: "open-addrepo" }
  | { type: "remove-repo"; repo: string }
  | { type: "open-palette" }
  | { type: "open-help" }
  | { type: "open-file"; space: number; file: string }
  // review view
  | { type: "rv-file"; delta: 1 | -1 } // J / K: next, previous file
  | { type: "rv-check"; delta: 1 | -1 } // Shift J / Shift K: next, previous check
  | { type: "rv-toggle-file" } // Space: stage or unstage the selected file
  | { type: "rv-stage-all" } // Shift A
  | { type: "rv-unstage-all" } // Shift U
  | { type: "rv-focus-diff" } // Enter
  | { type: "rv-hunk"; delta: 1 | -1 } // Tab / Shift Tab
  | { type: "rv-hunk-stage" } // Y
  | { type: "rv-hunk-unstage" } // U
  | { type: "rv-run-all" } // R
  | { type: "rv-run-focused" } // Shift R
  | { type: "rv-toggle-log" }; // O

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
  /** The file tree drawer is open. */
  filesOpen?: boolean;
  /** Focus is inside the file tree drawer, which handles its own keys. */
  inFiles?: boolean;
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
  if (ctrl && !alt && (k === "p" || k === "P") && !c.overlay?.match(/^(newspace|commit|composer|links|help)$/)) {
    return { type: "quick-open" };
  }

  if (k === "Escape") {
    // Sheets with fields: the first Esc leaves the field, the next one closes the sheet.
    if (c.typing && (c.overlay === "commit" || c.overlay === "links")) return { type: "blur" };
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
  // The quick open sheet handles its own arrows and Enter.
  if (c.overlay === "quickopen") return null;
  if (c.overlay === "newspace") return k === "Enter" && ctrl ? { type: "newspace-submit" } : null;
  if (c.overlay === "commit") {
    if (k === "Enter" && ctrl) return { type: "commit-submit" };
    if (c.typing || ctrl || alt) return null;
    if (/^[1-9]$/.test(k)) return { type: "cc-move", to: Number(k) };
    switch (k) {
      case "j":
      case "J":
      case "ArrowDown":
        return { type: "cc-hunk", delta: 1 };
      case "k":
      case "K":
      case "ArrowUp":
        return { type: "cc-hunk", delta: -1 };
      case "[":
        return { type: "cc-group", delta: -1 };
      case "]":
        return { type: "cc-group", delta: 1 };
      case "t":
      case "T":
        return { type: "cc-type" };
      case "!":
        return { type: "cc-breaking" };
      case "g":
      case "G":
        return { type: "cc-split" };
      case "m":
      case "M":
        return { type: "cc-merge" };
      case "o":
      case "O":
        return { type: "cc-conventional" };
      case "Enter":
        return { type: "cc-edit" };
      default:
        return null;
    }
  }
  if (c.overlay === "links") {
    if (k === "ArrowDown") return { type: "links-move", delta: 1 };
    if (k === "ArrowUp") return { type: "links-move", delta: -1 };
    if (k === "Enter") return c.typing ? { type: "links-submit" } : { type: "links-open" };
    if (c.typing || ctrl || alt) return null;
    if (k === "j" || k === "J") return { type: "links-move", delta: 1 };
    if (k === "k" || k === "K") return { type: "links-move", delta: -1 };
    if (k === "Backspace" || k === "Delete") return { type: "links-remove" };
    return null;
  }
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
  // The file tree drawer reads its own keys (J K H L, Space, letters that start a filter...).
  if (c.inFiles) return null;
  if (ctrl || alt) return null;

  if (c.view === "review") {
    const r = resolveReviewKey(k, shift);
    if (r) return r;
  }

  switch (k) {
    case "/":
      return c.filesOpen ? { type: "files-filter" } : null;
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
      return { type: "toggle-files" };
    case "s":
    case "S":
      return { type: "toggle-stack" };
    case "c":
    case "C":
      return { type: "open-commit" };
    case "l":
    case "L":
      return { type: "open-links" };
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

/** Keys of the Review view; they take precedence over the global ones. */
export function resolveReviewKey(k: string, shift: boolean): Action | null {
  switch (k) {
    case "j":
    case "J":
    case "ArrowDown":
      return shift ? { type: "rv-check", delta: 1 } : { type: "rv-file", delta: 1 };
    case "k":
    case "K":
    case "ArrowUp":
      return shift ? { type: "rv-check", delta: -1 } : { type: "rv-file", delta: -1 };
    case " ":
      return { type: "rv-toggle-file" };
    case "A":
      return { type: "rv-stage-all" };
    case "U":
      return { type: "rv-unstage-all" };
    case "Enter":
      return shift ? null : { type: "rv-focus-diff" };
    case "Tab":
      return { type: "rv-hunk", delta: shift ? -1 : 1 };
    case "y":
    case "Y":
      return { type: "rv-hunk-stage" };
    case "u":
      return { type: "rv-hunk-unstage" };
    case "r":
      return { type: "rv-run-all" };
    case "R":
      return { type: "rv-run-focused" };
    case "o":
    case "O":
      return { type: "rv-toggle-log" };
    default:
      return null;
  }
}
