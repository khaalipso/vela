// The pure parts of the context menu: placement, which entry the keys reach, tidy lists.
import { describe, expect, it } from "vitest";
import {
  SEP,
  clampToViewport,
  firstIndex,
  labels,
  lastIndex,
  letterIndex,
  nextIndex,
  placeSubmenu,
  tidy,
  type MenuEntry,
} from "./contextmenu.svelte";
import { closeOthers, closeToRight, currentAfter, renameKeys, setPinned } from "./tabs";
import { hunkPatch } from "./patch";
import { nameProblem } from "./ops.svelte";
import { resolveKey, shortcutFor, type KeyContext } from "./keymap";
import { withNewRow, EDIT_ID, type Row, type TNode } from "./filetree";
import type { Hunk } from "./types";

const item = (label: string, extra: Partial<MenuEntry> = {}): MenuEntry => ({ id: label, label, ...extra }) as MenuEntry;

describe("placement", () => {
  it("stays where it opened when it fits", () => {
    expect(clampToViewport(100, 120, 200, 300, 1000, 800)).toEqual({ x: 100, y: 120 });
  });

  it("slides left and up when it would run off the right and bottom edges", () => {
    expect(clampToViewport(950, 700, 220, 300, 1000, 800)).toEqual({ x: 1000 - 220 - 8, y: 800 - 300 - 8 });
  });

  it("keeps a margin from the top left corner", () => {
    expect(clampToViewport(-20, 2, 200, 100, 1000, 800)).toEqual({ x: 8, y: 8 });
  });

  it("a menu taller than the window sticks to the top margin", () => {
    expect(clampToViewport(10, 500, 200, 900, 1000, 800)).toEqual({ x: 10, y: 8 });
  });

  it("a submenu opens on the right of its item, and on the left when there is no room", () => {
    const item = { left: 100, right: 320, top: 200 };
    const r = placeSubmenu(item, 200, 150, 1000, 800);
    expect(r.flipped).toBe(false);
    expect(r.x).toBe(316);
    expect(r.y).toBe(196);
    const l = placeSubmenu({ left: 700, right: 920, top: 200 }, 200, 150, 1000, 800);
    expect(l.flipped).toBe(true);
    expect(l.x).toBe(504);
    // near the bottom it moves up
    expect(placeSubmenu(item, 200, 300, 1000, 400).y).toBe(92);
  });
});

describe("keyboard targets", () => {
  const list: MenuEntry[] = [item("Open"), SEP, item("Rename"), item("Delete"), SEP, item("Reveal")];

  it("arrows skip separators and wrap", () => {
    expect(nextIndex(list, -1, 1)).toBe(0);
    expect(nextIndex(list, 0, 1)).toBe(2);
    expect(nextIndex(list, 3, 1)).toBe(5);
    expect(nextIndex(list, 5, 1)).toBe(0);
    expect(nextIndex(list, 0, -1)).toBe(5);
    expect(nextIndex(list, 2, -1)).toBe(0);
    expect(nextIndex(list, -1, -1)).toBe(5);
  });

  it("Home and End", () => {
    expect(firstIndex(list)).toBe(0);
    expect(lastIndex(list)).toBe(5);
  });

  it("a menu of separators only has no target", () => {
    expect(nextIndex([SEP], 0, 1)).toBe(-1);
  });

  it("a letter jumps to the next label that starts with it, wrapping", () => {
    expect(letterIndex(list, -1, "r")).toBe(2);
    expect(letterIndex(list, 2, "r")).toBe(5);
    expect(letterIndex(list, 5, "r")).toBe(2);
    expect(letterIndex(list, 0, "D")).toBe(3);
    expect(letterIndex(list, 0, "z")).toBe(-1);
  });
});

describe("tidy", () => {
  it("drops separators at the ends and doubled ones, and falsy entries", () => {
    const out = tidy([SEP, item("A"), SEP, SEP, null, item("B"), false, SEP]);
    expect(labels(out)).toEqual(["A", "-", "B"]);
  });
});

describe("shortcuts come from the keymap", () => {
  it("finds the key that really runs the action", () => {
    expect(shortcutFor({ type: "rv-hunk-stage" }, "review")).toBe("Y");
    expect(shortcutFor({ type: "rv-hunk-unstage" }, "review")).toBe("U");
    expect(shortcutFor({ type: "reject" }, "review")).toBe("N");
    expect(shortcutFor({ type: "edit" }, "review")).toBe("E");
    expect(shortcutFor({ type: "toggle-window" })).toBe("W");
    expect(shortcutFor({ type: "rv-stage-all" }, "review")).toBe("Shift A");
    expect(shortcutFor({ type: "rv-toggle-file" }, "review")).toBe("Space");
    expect(shortcutFor({ type: "quick-open" })).toBe("Ctrl P");
  });

  it("an action without a key has no hint", () => {
    expect(shortcutFor({ type: "remove-repo", repo: "api" })).toBeUndefined();
    expect(shortcutFor({ type: "rv-hunk-stage" }, "code")).toBeUndefined();
  });

  it("the Menu key and Shift F10 open the menu, even while typing", () => {
    const ctx: KeyContext = { typing: true, overlay: null, stackOpen: false, view: "code", hasQuestion: false };
    expect(resolveKey({ key: "ContextMenu" }, ctx)).toEqual({ type: "context-menu" });
    expect(resolveKey({ key: "F10", shiftKey: true }, ctx)).toEqual({ type: "context-menu" });
    expect(resolveKey({ key: "F10" }, ctx)).toBeNull();
  });

  it("no letter shortcut acts behind a sheet", () => {
    const ctx: KeyContext = { typing: false, overlay: "sheet", stackOpen: false, view: "review", hasQuestion: false };
    for (const k of ["y", "n", "e", "c", "w", "Enter", "j"]) expect(resolveKey({ key: k }, ctx)).toBeNull();
    expect(resolveKey({ key: "Escape" }, ctx)).toEqual({ type: "close" });
  });
});

describe("tabs", () => {
  const tabs = [
    { key: "api/a.ts", pinned: true },
    { key: "api/b.ts", pinned: false },
    { key: "web/c.ts", pinned: true },
  ];

  it("close others, close to the right", () => {
    expect(closeOthers(tabs, "api/b.ts").map((t) => t.key)).toEqual(["api/b.ts"]);
    expect(closeToRight(tabs, "api/a.ts").map((t) => t.key)).toEqual(["api/a.ts"]);
    expect(closeToRight(tabs, "web/c.ts")).toHaveLength(3);
    expect(closeToRight(tabs, "nope")).toBe(tabs);
  });

  it("pin and unpin one tab", () => {
    expect(setPinned(tabs, "api/b.ts", true).find((t) => t.key === "api/b.ts")?.pinned).toBe(true);
    expect(setPinned(tabs, "api/a.ts", false).find((t) => t.key === "api/a.ts")?.pinned).toBe(false);
  });

  it("the file shown after closing some tabs", () => {
    const left = closeToRight(tabs, "api/a.ts");
    expect(currentAfter(left, "web/c.ts", "api/a.ts")).toBe("api/a.ts");
    expect(currentAfter(left, "api/a.ts", "x")).toBe("api/a.ts");
    expect(currentAfter([], "a", "b")).toBe("");
  });

  it("renaming a folder moves every key under it", () => {
    expect(renameKeys(["api/src/a.ts", "api/src", "api/srcx/b.ts", "web/src/a.ts"], "api/src", "api/lib")).toEqual([
      "api/lib/a.ts",
      "api/lib",
      "api/srcx/b.ts",
      "web/src/a.ts",
    ]);
  });
});

describe("copy hunk as patch", () => {
  const hunk: Hunk = {
    id: "h",
    repo: "api",
    path: "src/a.ts",
    oldStart: 10,
    oldLines: 2,
    newStart: 10,
    newLines: 1,
    section: "function run()",
    lines: [
      { kind: "context", text: "keep", old: 10, new: 10 },
      { kind: "del", text: "old", old: 11, new: null },
      { kind: "add", text: "new", old: null, new: 11 },
    ],
    origin: { type: "you" },
    state: "pending",
  };

  it("writes a unified diff", () => {
    expect(hunkPatch(hunk)).toBe(
      ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,2 +10 @@ function run()", " keep", "-old", "+new", ""].join("\n"),
    );
  });
});

describe("names typed in the tree", () => {
  it("accepts plain names, and paths only when nested ones are allowed", () => {
    expect(nameProblem("index.ts", false)).toBeNull();
    expect(nameProblem("a/b.ts", true)).toBeNull();
    expect(nameProblem("a/b.ts", false)).toMatch(/slash/);
  });

  it("refuses empty, absolute, dot-dot and .git names", () => {
    for (const bad of ["", "  ", "/etc/x", "../x", "a/../b", "a//b", ".git/config", "a\u0000b"]) {
      expect(nameProblem(bad, true), bad).not.toBeNull();
    }
  });
});

describe("the row that names a new entry", () => {
  const node = (id: string, kind: TNode["kind"], repo: string, path: string): TNode => ({
    id,
    kind,
    name: path.split("/").pop() ?? repo,
    repo,
    path,
    children: [],
    staged: 0,
    unstaged: 0,
    changed: 0,
  });
  const rows: Row[] = [
    { node: node("r:api", "repo", "api", ""), depth: 0 },
    { node: node("d:api/src", "dir", "api", "src"), depth: 1 },
    { node: node("f:api/src/a.ts", "file", "api", "src/a.ts"), depth: 2 },
    { node: node("r:web", "repo", "web", ""), depth: 0 },
  ];

  it("goes first inside its folder, one level deeper", () => {
    const out = withNewRow(rows, "api", "src");
    expect(out.map((r) => r.node.id)).toEqual(["r:api", "d:api/src", EDIT_ID, "f:api/src/a.ts", "r:web"]);
    expect(out[2].depth).toBe(2);
  });

  it("a repo root hosts it too, and an unknown folder leaves the rows alone", () => {
    expect(withNewRow(rows, "web", "").map((r) => r.node.id)).toEqual(["r:api", "d:api/src", "f:api/src/a.ts", "r:web", EDIT_ID]);
    expect(withNewRow(rows, "api", "nope")).toBe(rows);
  });
});
