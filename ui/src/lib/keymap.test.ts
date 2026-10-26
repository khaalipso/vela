import { describe, expect, it } from "vitest";
import { resolveKey, type Action, type KeyContext, type KeyLike } from "./keymap";

const ctx = (o: Partial<KeyContext> = {}): KeyContext => ({
  typing: false,
  overlay: null,
  stackOpen: false,
  view: "review",
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
      ["b", { type: "toggle-changes" }],
      ["B", { type: "toggle-changes" }],
      ["s", { type: "toggle-stack" }],
      ["c", { type: "open-commit" }],
      ["w", { type: "toggle-window" }],
      ["@", { type: "open-composer" }],
      ["?", { type: "open-help" }],
      ["e", { type: "edit" }],
      ["f", { type: "fix" }],
      ["u", { type: "undo" }],
    ];
    for (const [k, a] of table) expect(resolveKey(key(k), ctx())).toEqual(a);
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
    expect(resolveKey(key("y"), ctx({ view: "review", hasQuestion: true }))).toEqual({ type: "accept" });
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
    for (const overlay of ["palette", "newspace", "commit", "composer", "help"] as const) {
      expect(resolveKey(key("Escape"), ctx({ overlay, typing: true }))).toEqual({ type: "close" });
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
    expect(resolveKey(key("Enter"), ctx({ overlay: "commit" }))).toBeNull();
    expect(resolveKey(key("y"), ctx({ overlay: "commit" }))).toBeNull();
  });

  it("composer: Tab cycles the role, Enter sends, Shift Enter is a newline", () => {
    const c = ctx({ overlay: "composer", typing: true });
    expect(resolveKey(key("Tab"), c)).toEqual({ type: "composer-role", delta: 1 });
    expect(resolveKey(key("Tab", { shiftKey: true }), c)).toEqual({ type: "composer-role", delta: -1 });
    expect(resolveKey(key("Enter"), c)).toEqual({ type: "composer-send" });
    expect(resolveKey(key("Enter", { shiftKey: true }), c)).toBeNull();
  });

  it("shortcuts sheet: ? closes it, other keys do nothing", () => {
    expect(resolveKey(key("?"), ctx({ overlay: "help" }))).toEqual({ type: "close" });
    expect(resolveKey(key("y"), ctx({ overlay: "help" }))).toBeNull();
  });
});
