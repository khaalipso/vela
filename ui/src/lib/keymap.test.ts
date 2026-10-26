import { describe, expect, it } from "vitest";
import { isTyping, resolveKey, type Action, type KeyContext, type KeyLike } from "./keymap";

const ctx = (o: Partial<KeyContext> = {}): KeyContext => ({
  typing: false,
  overlay: null,
  stackOpen: false,
  view: "code",
  hasQuestion: false,
  ...o,
});
const key = (k: string, o: Partial<KeyLike> = {}): KeyLike => ({ key: k, ...o });

describe("global shortcuts", () => {
  it("Ctrl K and Cmd K toggle the command bar, even while typing or in an overlay", () => {
    expect(resolveKey(key("k", { ctrlKey: true }), ctx())).toEqual({ type: "palette-toggle" });
    expect(resolveKey(key("K", { metaKey: true }), ctx())).toEqual({ type: "palette-toggle" });
    expect(resolveKey(key("k", { ctrlKey: true }), ctx({ typing: true }))).toEqual({ type: "palette-toggle" });
    expect(resolveKey(key("k", { ctrlKey: true }), ctx({ overlay: "commit" }))).toEqual({ type: "palette-toggle" });
  });

  it("Enter does up next, Shift Enter jumps to the next waiting space", () => {
    expect(resolveKey(key("Enter"), ctx())).toEqual({ type: "up-next" });
    expect(resolveKey(key("Enter", { shiftKey: true }), ctx())).toEqual({ type: "next-waiting" });
  });

  it("1 2 3 switch views", () => {
    expect(resolveKey(key("1"), ctx())).toEqual({ type: "view", view: "code" });
    expect(resolveKey(key("2"), ctx())).toEqual({ type: "view", view: "review" });
    expect(resolveKey(key("3"), ctx())).toEqual({ type: "view", view: "agents" });
  });

  it("[ and ] switch spaces, Alt 1..9 jumps", () => {
    expect(resolveKey(key("["), ctx())).toEqual({ type: "space-prev" });
    expect(resolveKey(key("]"), ctx())).toEqual({ type: "space-next" });
    expect(resolveKey(key("1", { altKey: true }), ctx())).toEqual({ type: "space-jump", index: 0 });
    expect(resolveKey(key("9", { altKey: true }), ctx())).toEqual({ type: "space-jump", index: 8 });
    // layouts where Alt changes the character: fall back on the physical key
    expect(resolveKey(key("¡", { altKey: true, code: "Digit1" }), ctx())).toEqual({ type: "space-jump", index: 0 });
    expect(resolveKey(key("0", { altKey: true }), ctx())).toBeNull();
  });

  it("the other single keys", () => {
    const table: [string, Action][] = [
      ["b", { type: "toggle-files" }],
      ["B", { type: "toggle-files" }],
      ["s", { type: "toggle-stack" }],
      ["c", { type: "open-commit" }],
      ["l", { type: "open-links" }],
      ["L", { type: "open-links" }],
      ["w", { type: "toggle-window" }],
      ["@", { type: "open-composer" }],
      ["?", { type: "open-help" }],
      ["e", { type: "edit" }],
      ["f", { type: "fix" }],
      ["u", { type: "undo" }],
    ];
    for (const [k, a] of table) expect(resolveKey(key(k), ctx())).toEqual(a);
  });

  it("Ctrl P opens quick open, / filters the open file tree, the tree keeps its own keys", () => {
    expect(resolveKey(key("p", { ctrlKey: true }), ctx())).toEqual({ type: "quick-open" });
    expect(resolveKey(key("/"), ctx())).toBeNull();
    expect(resolveKey(key("/"), { ...ctx(), filesOpen: true })).toEqual({ type: "files-filter" });
    expect(resolveKey(key("j"), { ...ctx(), inFiles: true })).toBeNull();
    expect(resolveKey(key("2", { altKey: true }), { ...ctx(), inFiles: true })).toEqual({ type: "space-jump", index: 1 });
  });

  it("unknown keys are not ours", () => {
    expect(resolveKey(key("x"), ctx())).toBeNull();
    expect(resolveKey(key("Tab"), ctx())).toBeNull();
  });
});

describe("proposals", () => {
  it("J K and arrows move", () => {
    expect(resolveKey(key("j"), ctx())).toEqual({ type: "move", delta: 1 });
    expect(resolveKey(key("J"), ctx())).toEqual({ type: "move", delta: 1 });
    expect(resolveKey(key("ArrowDown"), ctx())).toEqual({ type: "move", delta: 1 });
    expect(resolveKey(key("k"), ctx())).toEqual({ type: "move", delta: -1 });
    expect(resolveKey(key("ArrowUp"), ctx({ view: "code" }))).toEqual({ type: "move", delta: -1 });
  });

  it("do not move in the agents view", () => {
    expect(resolveKey(key("j"), ctx({ view: "agents" }))).toBeNull();
    expect(resolveKey(key("k"), ctx({ view: "agents" }))).toBeNull();
    expect(resolveKey(key("ArrowDown"), ctx({ view: "agents" }))).toBeNull();
  });

  it("Y and N accept and reject, or answer the open question in the agents view", () => {
    expect(resolveKey(key("y"), ctx())).toEqual({ type: "accept" });
    expect(resolveKey(key("N"), ctx())).toEqual({ type: "reject" });
    expect(resolveKey(key("y"), ctx({ view: "agents", hasQuestion: true }))).toEqual({ type: "answer", yes: true });
    expect(resolveKey(key("n"), ctx({ view: "agents", hasQuestion: true }))).toEqual({ type: "answer", yes: false });
    // a question elsewhere than the agents view does not capture Y and N
    expect(resolveKey(key("y"), ctx({ view: "code", hasQuestion: true }))).toEqual({ type: "accept" });
    expect(resolveKey(key("n"), ctx({ view: "agents", hasQuestion: false }))).toEqual({ type: "reject" });
  });
});

describe("typing", () => {
  it("ignores every single letter and symbol while typing", () => {
    for (const k of ["j", "k", "y", "n", "e", "u", "f", "b", "s", "c", "w", "@", "?", "1", "2", "3", "[", "]", "Enter"]) {
      expect(resolveKey(key(k), ctx({ typing: true }))).toBeNull();
    }
  });

  it("ignores Alt digits while typing", () => {
    expect(resolveKey(key("1", { altKey: true }), ctx({ typing: true }))).toBeNull();
  });

  it("Escape leaves the field", () => {
    expect(resolveKey(key("Escape"), ctx({ typing: true }))).toEqual({ type: "blur" });
  });

  it("Escape does nothing when idle", () => {
    expect(resolveKey(key("Escape"), ctx())).toBeNull();
  });
});

describe("modifiers", () => {
  it("Ctrl or Alt with a letter is left to the browser", () => {
    expect(resolveKey(key("c", { ctrlKey: true }), ctx())).toBeNull();
    expect(resolveKey(key("c", { metaKey: true }), ctx())).toBeNull();
    expect(resolveKey(key("y", { altKey: true }), ctx())).toBeNull();
    expect(resolveKey(key("Enter", { ctrlKey: true }), ctx())).toBeNull();
  });
});

describe("overlays", () => {
  it("Escape closes an overlay or the stack popover", () => {
    for (const overlay of ["palette", "newspace", "composer", "help"] as const) {
      expect(resolveKey(key("Escape"), ctx({ overlay, typing: true }))).toEqual({ type: "close" });
    }
    for (const overlay of ["commit", "links"] as const) {
      expect(resolveKey(key("Escape"), ctx({ overlay }))).toEqual({ type: "close" });
    }
    expect(resolveKey(key("Escape"), ctx({ stackOpen: true }))).toEqual({ type: "close" });
  });

  it("command bar: arrows move, Enter runs, letters are typed", () => {
    const c = ctx({ overlay: "palette", typing: true });
    expect(resolveKey(key("ArrowDown"), c)).toEqual({ type: "palette-move", delta: 1 });
    expect(resolveKey(key("ArrowUp"), c)).toEqual({ type: "palette-move", delta: -1 });
    expect(resolveKey(key("Enter"), c)).toEqual({ type: "palette-run" });
    expect(resolveKey(key("y"), c)).toBeNull();
  });

  it("new space and commit: Ctrl Enter submits", () => {
    expect(resolveKey(key("Enter", { ctrlKey: true }), ctx({ overlay: "newspace" }))).toEqual({ type: "newspace-submit" });
    expect(resolveKey(key("Enter", { metaKey: true }), ctx({ overlay: "commit" }))).toEqual({ type: "commit-submit" });
    expect(resolveKey(key("Enter", { ctrlKey: true }), ctx({ overlay: "commit", typing: true }))).toEqual({ type: "commit-submit" });
    expect(resolveKey(key("y"), ctx({ overlay: "commit" }))).toBeNull();
  });

  it("commit composer: Esc leaves the field first, then closes", () => {
    expect(resolveKey(key("Escape"), ctx({ overlay: "commit", typing: true }))).toEqual({ type: "blur" });
    expect(resolveKey(key("Escape"), ctx({ overlay: "commit", typing: false }))).toEqual({ type: "close" });
  });

  it("commit composer: single keys act only outside fields", () => {
    const c = ctx({ overlay: "commit" });
    const cases: [string, Action][] = [
      ["t", { type: "cc-type" }],
      ["T", { type: "cc-type" }],
      ["!", { type: "cc-breaking" }],
      ["j", { type: "cc-hunk", delta: 1 }],
      ["ArrowDown", { type: "cc-hunk", delta: 1 }],
      ["k", { type: "cc-hunk", delta: -1 }],
      ["K", { type: "cc-hunk", delta: -1 }],
      ["1", { type: "cc-move", to: 1 }],
      ["9", { type: "cc-move", to: 9 }],
      ["g", { type: "cc-split" }],
      ["m", { type: "cc-merge" }],
      ["o", { type: "cc-conventional" }],
      ["[", { type: "cc-group", delta: -1 }],
      ["]", { type: "cc-group", delta: 1 }],
      ["Enter", { type: "cc-edit" }],
    ];
    for (const [k, a] of cases) {
      expect(resolveKey(key(k), c)).toEqual(a);
      expect(resolveKey(key(k), ctx({ overlay: "commit", typing: true }))).toBeNull();
    }
    expect(resolveKey(key("0"), c)).toBeNull();
    expect(resolveKey(key("y"), c)).toBeNull();
    expect(resolveKey(key("t", { ctrlKey: true }), c)).toBeNull();
  });

  it("links sheet: arrows work in the field, letters and Backspace only outside it", () => {
    const typing = ctx({ overlay: "links", typing: true });
    const idle = ctx({ overlay: "links" });
    expect(resolveKey(key("ArrowDown"), typing)).toEqual({ type: "links-move", delta: 1 });
    expect(resolveKey(key("ArrowUp"), typing)).toEqual({ type: "links-move", delta: -1 });
    expect(resolveKey(key("Enter"), typing)).toEqual({ type: "links-submit" });
    expect(resolveKey(key("j"), typing)).toBeNull();
    expect(resolveKey(key("Backspace"), typing)).toBeNull();
    expect(resolveKey(key("j"), idle)).toEqual({ type: "links-move", delta: 1 });
    expect(resolveKey(key("K"), idle)).toEqual({ type: "links-move", delta: -1 });
    expect(resolveKey(key("Enter"), idle)).toEqual({ type: "links-open" });
    expect(resolveKey(key("Backspace"), idle)).toEqual({ type: "links-remove" });
    expect(resolveKey(key("Delete"), idle)).toEqual({ type: "links-remove" });
    expect(resolveKey(key("y"), idle)).toBeNull();
    expect(resolveKey(key("k", { ctrlKey: true }), typing)).toEqual({ type: "palette-toggle" });
  });

  it("composer: Tab cycles the role, Shift Tab the harness, Ctrl Up/Down the tier, Enter sends", () => {
    const c = ctx({ overlay: "composer", typing: true });
    expect(resolveKey(key("Tab"), c)).toEqual({ type: "composer-role", delta: 1 });
    expect(resolveKey(key("Tab", { shiftKey: true }), c)).toEqual({ type: "composer-harness", delta: 1 });
    expect(resolveKey(key("ArrowUp", { ctrlKey: true }), c)).toEqual({ type: "composer-tier", delta: 1 });
    expect(resolveKey(key("ArrowDown", { ctrlKey: true }), c)).toEqual({ type: "composer-tier", delta: -1 });
    expect(resolveKey(key("ArrowUp"), c)).toBeNull();
    expect(resolveKey(key("Enter"), c)).toEqual({ type: "composer-send" });
    expect(resolveKey(key("Enter", { shiftKey: true }), c)).toBeNull();
  });

  it("shortcuts sheet: ? closes it, other keys do nothing", () => {
    expect(resolveKey(key("?"), ctx({ overlay: "help" }))).toEqual({ type: "close" });
    expect(resolveKey(key("y"), ctx({ overlay: "help" }))).toBeNull();
  });
});

describe("isTyping", () => {
  it("is true in inputs, textareas and contenteditable elements", () => {
    expect(isTyping({ tagName: "INPUT" })).toBe(true);
    expect(isTyping({ tagName: "textarea" })).toBe(true);
    expect(isTyping({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTyping({ tagName: "DIV", closest: () => ({}) })).toBe(true);
  });

  it("is false on buttons, the body and nothing", () => {
    expect(isTyping({ tagName: "BUTTON", closest: () => null })).toBe(false);
    expect(isTyping({ tagName: "BODY" })).toBe(false);
    expect(isTyping(null)).toBe(false);
    expect(isTyping(undefined)).toBe(false);
  });
});

describe("review view", () => {
  const r = (k: string, o: Partial<KeyLike> = {}) => resolveKey(key(k, o), ctx({ view: "review" }));

  it("J K move between files, Shift J K between checks", () => {
    expect(r("j")).toEqual({ type: "rv-file", delta: 1 });
    expect(r("ArrowUp")).toEqual({ type: "rv-file", delta: -1 });
    expect(r("J", { shiftKey: true })).toEqual({ type: "rv-check", delta: 1 });
    expect(r("K", { shiftKey: true })).toEqual({ type: "rv-check", delta: -1 });
  });

  it("Space stages the file, Shift A and Shift U do all", () => {
    expect(r(" ")).toEqual({ type: "rv-toggle-file" });
    expect(r("A", { shiftKey: true })).toEqual({ type: "rv-stage-all" });
    expect(r("U", { shiftKey: true })).toEqual({ type: "rv-unstage-all" });
  });

  it("Enter focuses the diff, Tab walks the hunks", () => {
    expect(r("Enter")).toEqual({ type: "rv-focus-diff" });
    expect(r("Enter", { shiftKey: true })).toEqual({ type: "next-waiting" });
    expect(r("Tab")).toEqual({ type: "rv-hunk", delta: 1 });
    expect(r("Tab", { shiftKey: true })).toEqual({ type: "rv-hunk", delta: -1 });
  });

  it("Y stages a hunk, U unstages it, N rejects a proposal", () => {
    expect(r("y")).toEqual({ type: "rv-hunk-stage" });
    expect(r("u")).toEqual({ type: "rv-hunk-unstage" });
    expect(r("n")).toEqual({ type: "reject" });
  });

  it("R runs the checks, Shift R the focused one, O opens the log, C commits", () => {
    expect(r("r")).toEqual({ type: "rv-run-all" });
    expect(r("R", { shiftKey: true })).toEqual({ type: "rv-run-focused" });
    expect(r("o")).toEqual({ type: "rv-toggle-log" });
    expect(r("c")).toEqual({ type: "open-commit" });
  });

  it("does nothing while typing, and the other views keep their keys", () => {
    expect(resolveKey(key(" "), ctx({ view: "review", typing: true }))).toBeNull();
    expect(resolveKey(key(" "), ctx({ view: "code" }))).toBeNull();
    expect(resolveKey(key("Tab"), ctx({ view: "agents" }))).toBeNull();
  });
});
