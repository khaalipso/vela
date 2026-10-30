export type View = "space" | "code" | "review" | "agents" | "prs";

/** The views in the order of the top bar (and of Ctrl Left / Right). */
export const VIEWS: View[] = ["space", "code", "agents", "review", "prs"];
export type Overlay =
  | "palette"
  | "quickopen"
  | "newspace"
  | "commit"
  | "composer"
  | "help"
  | "sheet"
  | "settings"
  | "filepeek"
  | null;

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
  | { type: "cc-repo"; delta: 1 | -1 } // commit the next / previous repo with staged changes
  | { type: "open-link"; id: string }
  | { type: "page-edit" } // Ctrl S on the space page: open or close the document for writing
  | { type: "hide-terminals" } // Esc in a terminal: every terminal panel goes away
  | { type: "composer-role"; delta: 1 | -1 }
  | { type: "composer-harness"; delta: 1 | -1 } // Shift Tab
  | { type: "composer-tier"; delta: 1 | -1 } // Ctrl Up raises, Ctrl Down lowers
  | { type: "composer-send" }
  | { type: "up-next" }
  | { type: "next-waiting" }
  | { type: "view"; view: View }
  | { type: "view-step"; delta: 1 | -1 } // Ctrl Left / Right: previous, next view
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
  | { type: "toggle-window" }
  | { type: "open-composer" }
  | { type: "open-newspace" }
  | { type: "browse-repos" }
  | { type: "open-addrepo" }
  | { type: "remove-repo"; repo: string }
  | { type: "move-repo-into-clone"; repo: string }
  | { type: "open-palette" }
  | { type: "open-help" }
  | { type: "open-file"; space: number; file: string }
  | { type: "context-menu" } // Menu key / Shift F10: the right-click menu of the focused item
  | { type: "find" } // Ctrl F: find in the open file
  | { type: "split" } // Ctrl \: split view of the code view
  | { type: "nav"; delta: 1 | -1 } // Ctrl Shift Right = back (older), Left = forward (more recent); mouse back / forward
  | { type: "open-peek"; repo: string; path: string } // a path named in an answer: its changes in a mini page
  | { type: "toggle-terminal"; dock?: "top" } // Ctrl ` or T or Ctrl Down: the terminal panel; Ctrl Up: the one on top
  | { type: "new-terminal" } // Ctrl Shift `: one more terminal
  | { type: "toggle-preview" } // V in the code view: Markdown preview
  | { type: "open-settings" } // agent tiers: model and effort per harness
  | { type: "open-prompts" } // the brief of each agent role
  | { type: "open-branch-settings" } // how new branches are named
  | { type: "agent-move"; delta: 1 | -1 } // J / K in the agents view
  | { type: "change-move"; delta: 1 | -1 } // Ctrl Alt Down / Up in the code view: next, previous change of yours
  | { type: "noop" } // a key taken from the browser that does nothing here
  | { type: "close-tab" } // Ctrl W: close the file tab shown in the editor
  | { type: "toggle-rail" } // Ctrl B: dock or hide the spaces bar (hidden: it floats in on the left edge)
  | { type: "prs-refresh" } // R in the pull requests view
  // review view
  | { type: "rv-file"; delta: 1 | -1 } // J / K: next, previous file
  | { type: "rv-check"; delta: 1 | -1 } // Shift J / Shift K: next, previous check
  | { type: "rv-toggle-file" } // Space: stage or unstage the selected file
  | { type: "rv-stage-all" } // stage every file of yours
  | { type: "rv-comment" } // M: comment the hunk under the cursor, an agent answers
  | { type: "rv-approve-all" } // Shift A: stage your edits and accept every proposal
  | { type: "rv-unstage-all" } // Shift U
  | { type: "rv-focus-diff" } // Enter
  | { type: "rv-hunk"; delta: 1 | -1 } // Tab / Shift Tab: next, previous change in the diff
  | { type: "rv-hunk-stage" } // Y
  | { type: "rv-hunk-unstage" } // U
  | { type: "rv-run-all" } // R
  | { type: "rv-run-focused" } // Shift R
  | { type: "rv-toggle-log" } // O
  | { type: "rv-split" } // V: side by side or unified diff
  | { type: "rv-note-resolve" } // Shift Y: resolve the note of the file
  | { type: "rv-reject-file" } // N: reject the agents' changes in the file
  | { type: "rv-open-editor" } // E: open the file in the editor
  | { type: "rv-accept-file" } // Y: accept the file
  | { type: "rv-unaccept-file" }; // U: take an accepted file back to review

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
  /** Focus is in a terminal, where Ctrl W deletes a word. */
  inTerm?: boolean;
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

  // Cmd/Ctrl T: the command bar (spaces, files, actions). Cmd/Ctrl K: ask an agent.
  if (ctrl && !alt && (k === "t" || k === "T")) return { type: "palette-toggle" };
  // Ctrl Shift F: the same command bar, where files and the rest are found.
  if (ctrl && !alt && shift && (k === "f" || k === "F")) return { type: "palette-toggle" };
  if (ctrl && !alt && (k === "k" || k === "K")) {
    return c.overlay === "composer" ? { type: "close" } : { type: "open-composer" };
  }
  // Cmd/Ctrl W closes the editor tab, never the window (the editor included).
  if (ctrl && !alt && !shift && (k === "w" || k === "W") && !c.inTerm) {
    return !c.overlay && c.view === "code" ? { type: "close-tab" } : { type: "noop" };
  }
  if (ctrl && !alt && !shift && (k === "b" || k === "B") && (!c.overlay || c.overlay === "palette")) {
    return { type: "toggle-rail" };
  }
  // The terminal toggles from anywhere, the terminal itself included.
  if (ctrl && !alt && (k === "`" || e.code === "Backquote") && (!c.overlay || c.overlay === "palette")) {
    return shift ? { type: "new-terminal" } : { type: "toggle-terminal" };
  }
  // Ctrl Shift Right goes back in time (older), Left comes back to the more recent: the list of places runs recent to old, left to right.
  if (ctrl && !alt && shift && (k === "ArrowLeft" || k === "ArrowRight") && !c.inTerm && (!c.overlay || c.overlay === "filepeek")) {
    return { type: "nav", delta: k === "ArrowRight" ? -1 : 1 };
  }
  // Ctrl Down shows or hides the terminal at the bottom, Ctrl Up the one on top, from a terminal
  // too; Ctrl Left / Right go through the views. In a text field or the editor these keys keep
  // moving the caret.
  if (ctrl && !alt && !shift && (!c.overlay || c.overlay === "palette")) {
    if (k === "ArrowDown" && (!c.typing || c.inTerm)) return { type: "toggle-terminal" };
    if (k === "ArrowUp" && (!c.typing || c.inTerm)) return { type: "toggle-terminal", dock: "top" };
    if ((k === "ArrowLeft" || k === "ArrowRight") && !c.typing) {
      return { type: "view-step", delta: k === "ArrowRight" ? 1 : -1 };
    }
  }
  // The menu key works everywhere, even in a text field or the editor.
  if (k === "ContextMenu" || (shift && !ctrl && !alt && k === "F10")) return { type: "context-menu" };
  if (ctrl && !alt && (k === "p" || k === "P") && !c.overlay?.match(/^(newspace|commit|composer|help)$/)) {
    return { type: "quick-open" };
  }

  // Esc in a terminal hides the panels (the shells keep running).
  if (k === "Escape" && c.inTerm && !c.overlay) return { type: "hide-terminals" };
  // Ctrl S on the page: write, or save and read, even from inside the editor.
  if (ctrl && !alt && !shift && (k === "s" || k === "S") && c.view === "space" && !c.overlay) return { type: "page-edit" };

  if (k === "Escape") {
    // Sheets with fields: the first Esc leaves the field, the next one closes the sheet.
    if (c.typing && c.overlay === "commit") return { type: "blur" };
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
      case "r":
        return { type: "cc-repo", delta: 1 };
      case "R":
        return { type: "cc-repo", delta: shift ? -1 : 1 };
      case "Enter":
        return { type: "cc-edit" };
      default:
        return null;
    }
  }
  if (c.overlay === "composer") {
    if (k === "Tab") return shift ? { type: "composer-harness", delta: 1 } : { type: "composer-role", delta: 1 };
    if (ctrl && k === "ArrowUp") return { type: "composer-tier", delta: 1 };
    if (ctrl && k === "ArrowDown") return { type: "composer-tier", delta: -1 };
    if (k === "Enter" && !shift) return { type: "composer-send" };
    return null;
  }
  if (c.overlay === "help") return k === "?" ? { type: "close" } : null;
  // Confirmation and prompt sheets take their own keys.
  if (c.overlay === "sheet" || c.overlay === "settings") return null;

  if (ctrl && alt && !shift && (k === "ArrowDown" || k === "ArrowUp") && !c.overlay && c.view === "code") {
    return { type: "change-move", delta: k === "ArrowDown" ? 1 : -1 };
  }
  // In the editor, CodeMirror opens its own search panel on Ctrl F.
  if (ctrl && !alt && !shift && (k === "f" || k === "F") && !c.overlay && c.view === "code" && !c.typing) {
    return { type: "find" };
  }

  if (ctrl && !alt && !shift && k === "\\" && !c.overlay && c.view === "code") return { type: "split" };

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
  if (c.view === "prs" && (k === "r" || k === "R")) return { type: "prs-refresh" };

  switch (k) {
    case "/":
      return c.filesOpen ? { type: "files-filter" } : null;
    case "Enter":
      return shift ? { type: "next-waiting" } : { type: "up-next" };
    case "0":
      return { type: "view", view: "space" };
    case "1":
      return { type: "view", view: "code" };
    case "2":
      return { type: "view", view: "agents" };
    case "3":
      return { type: "view", view: "review" };
    case "4":
      return { type: "view", view: "prs" };
    case "[":
      return { type: "space-prev" };
    case "]":
      return { type: "space-next" };
    case "j":
    case "J":
    case "ArrowDown":
      return c.view === "agents" ? { type: "agent-move", delta: 1 } : c.view === "prs" ? null : { type: "move", delta: 1 };
    case "k":
    case "K":
    case "ArrowUp":
      return c.view === "agents" ? { type: "agent-move", delta: -1 } : c.view === "prs" ? null : { type: "move", delta: -1 };
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
      return { type: "view", view: "space" };
    case "w":
    case "W":
      return { type: "toggle-window" };
    case "@":
      return { type: "open-composer" };
    case "t":
    case "T":
      return { type: "toggle-terminal" };
    case "v":
    case "V":
      return c.view === "code" ? { type: "toggle-preview" } : null;
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
      return { type: "rv-approve-all" };
    case "U":
      return { type: "rv-unstage-all" };
    case "Enter":
      return shift ? null : { type: "rv-focus-diff" };
    case "Tab":
      return { type: "rv-hunk", delta: shift ? -1 : 1 };
    case "y":
      return { type: "rv-accept-file" };
    case "Y":
      return shift ? { type: "rv-note-resolve" } : { type: "rv-accept-file" };
    case "u":
      return { type: "rv-unaccept-file" };
    case "n":
    case "N":
      return { type: "rv-reject-file" };
    case "e":
    case "E":
      return { type: "rv-open-editor" };
    case "v":
    case "V":
      return { type: "rv-split" };
    case "r":
      return { type: "rv-run-all" };
    case "R":
      return { type: "rv-run-focused" };
    case "o":
    case "O":
      return { type: "rv-toggle-log" };
    case "m":
    case "M":
      return { type: "rv-comment" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shortcut hints that cannot drift from the keymap
// ---------------------------------------------------------------------------

const HINT_KEYS: KeyLike[] = [
  ...[..."abcdefghijklmnopqrstuvwxyz0123456789@?/[]"].map((key) => ({ key })),
  ...[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((key) => ({ key, shiftKey: true })),
  { key: "Enter" },
  { key: "Enter", shiftKey: true },
  { key: " " },
  { key: "Tab" },
  { key: "Tab", shiftKey: true },
  { key: "p", ctrlKey: true },
  { key: "k", ctrlKey: true },
  { key: "t", ctrlKey: true },
];

/** The text of a hint as the UI writes it: `Y`, `Shift A`, `Ctrl P`, `Space`. */
export function keyLabel(e: KeyLike): string {
  const base = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return `${e.ctrlKey ? "Ctrl " : ""}${e.shiftKey ? "Shift " : ""}${base}`;
}

/**
 * The key that runs `action` in `view`, found by asking `resolveKey` itself, so a hint shown in
 * a menu is always a key that really works. Returns undefined when the action has no key.
 */
export function shortcutFor(action: Action, view: View = "code"): string | undefined {
  const ctx: KeyContext = { typing: false, overlay: null, stackOpen: false, view, hasQuestion: false, filesOpen: true };
  const want = JSON.stringify(action);
  for (const k of HINT_KEYS) {
    const got = resolveKey(k, ctx);
    if (got && JSON.stringify(got) === want) return keyLabel(k);
  }
  return undefined;
}
