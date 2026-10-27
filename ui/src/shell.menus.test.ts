// @vitest-environment jsdom
// Right-click menus in the whole shell: a `contextmenu` event opens one, the keyboard drives it,
// an item runs. Mock backend, no screen.
import { mount, tick, unmount } from "svelte";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";
import { app } from "./lib/app.svelte";
import { MockBackend } from "./lib/backend";
import { files } from "./lib/files.svelte";
import { menu } from "./lib/contextmenu.svelte";

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const settle = async () => {
  await tick();
  await new Promise((r) => setTimeout(r, 12));
  await tick();
};
const press = (key: string, o: KeyboardEventInit = {}, target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...o }));
const rightClick = (el: Element, x = 120, y = 90) => {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y });
  el.dispatchEvent(e);
  return e;
};
const items = () => $$('.ctxmenu:not(.sub) > .row > [role="menuitem"]').map((b) => b.querySelector(".lb")?.textContent);
const item = (label: string) => $$('.ctxmenu [role^="menuitem"]').find((b) => b.querySelector(".lb")?.textContent === label)!;
const active = () => document.activeElement?.querySelector(".lb")?.textContent;
/** Press a key and let the menu move the focus. */
const k = async (key: string, o: KeyboardEventInit = {}) => {
  press(key, o);
  await settle();
};
const row = (name: string) => $$(".files .row").find((r) => r.querySelector(".nm")?.textContent?.trim() === name)!;
const clip = vi.fn().mockResolvedValue(undefined);

let component: ReturnType<typeof mount>;
let backend: MockBackend;

beforeAll(async () => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(navigator, "clipboard", { value: { writeText: clip, readText: vi.fn().mockResolvedValue("pasted") }, configurable: true });
  localStorage.clear();
  backend = new MockBackend({ speed: 0 });
  await app.init(backend);
  app.filesOpen = true;
  component = mount(App, { target: document.body });
  await settle();
  await vi.waitFor(() => expect($$(".files .row.repo").length).toBeGreaterThan(0));
});
afterAll(() => {
  void unmount(component);
  app.destroy();
  files.stop();
});

async function closeMenu() {
  menu.close(false);
  await settle();
}

describe("opening", () => {
  it("a right click on a tree row opens the menu at the pointer and stops the browser's own", async () => {
    press("1");
    const tree = $(".files .tree")!;
    const r = row("webhook.ts");
    const e = rightClick(r, 140, 60);
    await settle();
    expect(e.defaultPrevented).toBe(true);
    const m = $(".ctxmenu")!;
    expect(m.getAttribute("role")).toBe("menu");
    expect(m.style.left).toBe("140px");
    expect(m.style.top).toBe("60px");
    expect(items()).toContain("Open pinned");
    expect(items()).toContain("Reveal in file manager");
    // the row under the pointer got the tree cursor
    expect(files.cursor).toBe("f:api/src/billing/webhook.ts");
    // the focus moved into the menu
    expect($(".ctxmenu")!.contains(document.activeElement)).toBe(true);
    press("Escape");
    await settle();
    expect(document.activeElement).toBe(tree);
  });

  it("anywhere else the browser's menu is suppressed and no menu opens", async () => {
    const e = rightClick($("h1")!);
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect($(".ctxmenu")).toBeNull();
  });

  it("a text field gets Cut, Copy, Paste and Select all", async () => {
    press("t", { ctrlKey: true });
    await settle();
    const input = $("#pal-in") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.setSelectionRange(0, 5);
    rightClick(input);
    await settle();
    expect(items()).toEqual(["Cut", "Copy", "Paste", "Select all"]);
    item("Paste").click();
    await settle();
    expect(input.value).toBe("pasted");
    press("Escape");
    await settle();
  });

  it("the ⋯ button of a row opens the same menu", async () => {
    const r = row("webhook.ts");
    const more = r.querySelector<HTMLButtonElement>("button.more")!;
    expect(more.getAttribute("aria-label")).toBe("Actions for webhook.ts");
    more.click();
    await settle();
    expect(items()).toContain("Rename…");
    expect(items()).toContain("Delete…");
    await closeMenu();
  });
});

describe("keyboard", () => {
  it("Menu key opens the menu of the row under the tree cursor, first item active", async () => {
    const tree = $(".files .tree")!;
    tree.focus();
    files.cursor = "f:api/src/billing/webhook.ts";
    await settle();
    press("ContextMenu", {}, tree);
    await settle();
    expect(items()[0]).toBe("Open");
    expect(active()).toBe("Open");
  });

  it("arrows move, wrap and skip separators; a letter jumps; Home and End", async () => {
    await k("ArrowDown");
    expect(active()).toBe("Open pinned");
    await k("ArrowDown");
    expect(active()).toBe("Stage");
    await k("ArrowUp");
    expect(active()).toBe("Open pinned");
    await k("ArrowUp");
    await k("ArrowUp");
    expect(active()).toBe("Filter to this folder");
    await k("r");
    expect(active()).toBe("Reveal in file manager");
    await k("r");
    expect(active()).toBe("Rename…");
    await k("Home");
    expect(active()).toBe("Open");
    await k("End");
    expect(active()).toBe("Filter to this folder");
    await k("Tab");
    expect(active()).toBe("Open");
  });

  it("keys do not leak to the shortcuts behind the menu", async () => {
    const view = app.view;
    press("2");
    press("b");
    expect(app.view).toBe(view);
    expect(app.filesOpen).toBe(true);
  });

  it("a disabled item says why and does nothing on Enter", async () => {
    press("Escape");
    await settle();
    const n = $(".files .tree")!;
    files.cursor = "f:api/package.json";
    await settle();
    press("ContextMenu", {}, n);
    await settle();
    const stage = item("Stage");
    expect(stage.getAttribute("aria-disabled")).toBe("true");
    expect(stage.getAttribute("title")).toMatch(/No changes/);
    await k("s");
    expect(active()).toBe("Stage");
    await k("Enter");
    expect($(".ctxmenu")).toBeTruthy();
  });

  it("Esc closes and gives the focus back to the tree", async () => {
    press("Escape");
    await settle();
    expect($(".ctxmenu")).toBeNull();
    expect(document.activeElement).toBe($(".files .tree"));
  });

  it("Enter runs the active item and closes the menu", async () => {
    files.cursor = "f:api/src/billing/webhook.ts";
    await settle();
    press("ContextMenu", {}, $(".files .tree")!);
    await settle();
    await k("c"); // Copy path
    expect(active()).toBe("Copy path");
    await k("Enter");
    expect($(".ctxmenu")).toBeNull();
    await vi.waitFor(() => expect(clip).toHaveBeenCalledWith(expect.stringMatching(/\/api\/src\/billing\/webhook\.ts$|wt\/stripe-v2\/src\/billing\/webhook\.ts$/)));
    expect(app.toastState?.text).toBe("Copied the path");
  });
});

describe("closing", () => {
  const open = async () => {
    rightClick(row("webhook.ts"), 50, 50);
    await settle();
    expect($(".ctxmenu")).toBeTruthy();
  };

  it("an outside press closes it, a press inside does not", async () => {
    await open();
    $(".ctxmenu")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect($(".ctxmenu")).toBeTruthy();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await settle();
    expect($(".ctxmenu")).toBeNull();
  });

  it("a scroll elsewhere closes it", async () => {
    await open();
    $(".files .scroll")!.dispatchEvent(new Event("scroll"));
    await settle();
    expect($(".ctxmenu")).toBeNull();
  });

  it("the window losing focus closes it", async () => {
    await open();
    window.dispatchEvent(new Event("blur"));
    await settle();
    expect($(".ctxmenu")).toBeNull();
  });

  it("a second right click replaces the first menu", async () => {
    await open();
    rightClick(row("webhook.ts"), 300, 200);
    await settle();
    expect($$(".ctxmenu")).toHaveLength(1);
    expect($(".ctxmenu")!.style.left).toBe("300px");
    await closeMenu();
  });
});

describe("tree actions end to end", () => {
  it("Rename… edits the name in the row; Enter renames, Esc cancels", async () => {
    await backend.createFile(app.space.id, "api", "tmp/note.txt");
    await app.refresh();
    await files.load(app.space.id);
    await settle();
    await ops_reveal("api/tmp/note.txt");
    const r = row("note.txt");
    rightClick(r);
    await settle();
    item("Rename…").click();
    await settle();
    const input = $("input[data-tree-edit]") as HTMLInputElement;
    expect(input.value).toBe("note.txt");
    expect(document.activeElement).toBe(input);
    // keys typed in the field are not tree shortcuts
    input.value = "renamed.txt";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    press("j", {}, input);
    expect(files.cursor).toBe("f:api/tmp/note.txt");
    press("Enter", {}, input);
    await settle();
    await vi.waitFor(() => expect(row("renamed.txt")).toBeTruthy());
    expect($("input[data-tree-edit]")).toBeNull();
  });

  it("F2 on the cursor row renames, Esc cancels without touching the file", async () => {
    files.cursor = "f:api/tmp/renamed.txt";
    $(".files .tree")!.focus();
    press("F2", {}, $(".files .tree")!);
    await settle();
    const input = $("input[data-tree-edit]") as HTMLInputElement;
    expect(input.value).toBe("renamed.txt");
    press("Escape", {}, input);
    await settle();
    expect($("input[data-tree-edit]")).toBeNull();
    expect(row("renamed.txt")).toBeTruthy();
  });

  it("New file here shows a row in the folder, names and opens the file", async () => {
    rightClick(row("renamed.txt"));
    await settle();
    item("New file here").click();
    await settle();
    const input = $("input[data-tree-edit]") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.getAttribute("aria-label")).toBe("Name of the new file");
    input.value = "created.md";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    press("Enter", {}, input);
    await settle();
    await vi.waitFor(() => expect(app.cui.file).toBe("api/tmp/created.md"));
    expect(row("created.md")).toBeTruthy();
  });

  it("Discard changes… on an untracked file needs the box ticked, and Esc leaves it alone", async () => {
    rightClick(row("created.md"));
    await settle();
    item("Discard changes…").click();
    await settle();
    const dlg = $("[role='alertdialog']")!;
    expect(dlg.textContent).toContain("Delete created.md?");
    expect(dlg.textContent).toContain("api/tmp/created.md".replace("api/", ""));
    const ok = $$("[role='alertdialog'] button[type='submit']")[0] as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    // a stray Enter lands on Cancel for a destructive sheet
    expect(document.activeElement?.textContent).toBe("Cancel");
    // letters do not reach the shortcuts behind the sheet
    const v = app.view;
    press("2");
    expect(app.view).toBe(v);
    press("Escape");
    await settle();
    expect($("[role='alertdialog']")).toBeNull();
    expect(row("created.md")).toBeTruthy();

    rightClick(row("created.md"));
    await settle();
    item("Discard changes…").click();
    await settle();
    const box = $("[role='alertdialog'] input[type='checkbox']") as HTMLInputElement;
    box.click();
    await settle();
    const ok2 = $$("[role='alertdialog'] button[type='submit']")[0] as HTMLButtonElement;
    expect(ok2.disabled).toBe(false);
    ok2.click();
    await settle();
    await vi.waitFor(() => expect($$(".files .row").some((r) => r.querySelector(".nm")?.textContent?.trim() === "created.md")).toBe(false));
  });

  it("Delete… moves the file to the trash and says so", async () => {
    rightClick(row("renamed.txt"));
    await settle();
    item("Delete…").click();
    await settle();
    await vi.waitFor(() => expect(backend.trashed).toContain("api/tmp/renamed.txt"));
    expect(app.toastState?.text).toBe("Moved renamed.txt to the trash");
  });

  it("a repo node: Open terminal here reaches the backend with the worktree root", async () => {
    const repoRow = $$(".files .row.repo")[0];
    const repo = repoRow.querySelector(".nm")!.textContent!.trim();
    rightClick(repoRow);
    await settle();
    expect(items()).toContain("Copy worktree path");
    item("Open terminal here").click();
    await settle();
    expect(backend.terminals).toContain(repo);
  });
});

async function ops_reveal(key: string) {
  const { ops } = await import("./lib/ops.svelte");
  await ops.revealInTree(key);
  await settle();
}

describe("tabs and editor", () => {
  it("a right click on a tab offers Close others and friends", async () => {
    app.openFile(app.active, "api/lib/stripe.ts", true);
    app.openFile(app.active, "api/src/billing/webhook.ts", true);
    await settle();
    const tab = $$(".tab").find((t) => t.querySelector(".rp")?.textContent === "api" && t.querySelector(".mono")?.textContent === "lib/stripe.ts")!;
    rightClick(tab);
    await settle();
    expect(items()).toEqual(["Close", "Close others", "Close to the right", "Close all", "Unpin", "Copy path", "Reveal in tree"]);
    item("Close others").click();
    await settle();
    expect($$(".tab")).toHaveLength(1);
    expect(app.cui.file).toBe("api/lib/stripe.ts");
  });

  it("a right click in the editor offers the clipboard actions and Go to line", async () => {
    await vi.waitFor(() => expect($(".cm-content")).toBeTruthy());
    rightClick($(".cm-content")!, 200, 150);
    await settle();
    expect(items().slice(0, 4)).toEqual(["Cut", "Copy", "Paste", "Select all"]);
    expect(items()).toContain("Copy link to line");
    item("Go to line…").click();
    await settle();
    const input = $("#sheet-in") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = "x";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    $("[role='dialog'] form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect($("[role='dialog'] .problem")?.textContent).toBe("Type a line number");
    press("Escape", {}, input);
    await settle();
    expect($("[role='dialog']")).toBeNull();
  });
});

describe("spaces", () => {
  it("a right click on a space in the rail; the color submenu opens with the arrow and applies", async () => {
    const sp = $$(".rail .sp")[0];
    rightClick(sp, 60, 200);
    await settle();
    expect(items()).toEqual(["Rename…", "Change color", "Open in its own window", "Copy branch name", "Archive", "Remove space…"]);
    expect(item("Open in its own window").textContent).toContain("W");
    item("Change color").dispatchEvent(new PointerEvent("pointerenter"));
    await settle();
    expect($$(".ctxmenu.sub [role^='menuitem']").map((b) => b.querySelector(".lb")?.textContent)).toEqual(["Amber", "Sky", "Violet", "Green", "Pink", "Mint"]);
    await k("ArrowLeft");
    expect($(".ctxmenu.sub")).toBeNull();
    expect(active()).toBe("Change color");
    await k("ArrowRight");
    expect($(".ctxmenu.sub")).toBeTruthy();
    await k("v"); // Violet
    await k("Enter");
    await vi.waitFor(() => expect(app.spaces[0].color).toBe("#C9A0F0"));
    expect($(".ctxmenu")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--space")).toBe("#C9A0F0");
  });

  it("Archive moves it to the Archived section of the rail; Restore brings it back", async () => {
    const before = $$(".rail .sp").length;
    const name = app.spaces[1].name;
    rightClick($$(".rail .sp")[1]);
    await settle();
    item("Archive").click();
    await settle();
    await vi.waitFor(() => expect($$(".rail .sp")).toHaveLength(before - 1));
    const head = $(".rail .archhead")!;
    expect(head.textContent).toContain("Archived");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    head.click();
    await settle();
    expect($(".rail .ar")?.textContent).toContain(name);
    $(".rail .restore")!.click();
    await vi.waitFor(() => expect($$(".rail .sp")).toHaveLength(before));
    expect($(".rail .archhead")).toBeNull();
  });

  it("Remove space… explains and removes it only after the confirm", async () => {
    const n = app.spaces.length;
    rightClick($$(".rail .sp")[2]);
    await settle();
    item("Remove space…").click();
    await settle();
    const dlg = $("[role='alertdialog']")!;
    expect(dlg.textContent).toContain("worktrees of this space are removed");
    expect(dlg.textContent).toContain("unmerged commits stays");
    expect(document.activeElement?.textContent).toBe("Cancel");
    press("Escape");
    await settle();
    expect(app.spaces).toHaveLength(n);
    rightClick($$(".rail .sp")[2]);
    await settle();
    item("Remove space…").click();
    await settle();
    $$("[role='alertdialog'] button[type='submit']")[0].click();
    await vi.waitFor(() => expect(app.spaces).toHaveLength(n - 1));
  });

  it("a repo chip in the top bar", async () => {
    rightClick($(".top .chip")!);
    await settle();
    expect(items()).toEqual(["Show files", "Copy worktree path", "Reveal worktree", "Open terminal here", "Remove repo from space"]);
    item("Reveal worktree").click();
    await settle();
    expect(backend.revealed).toContain("api");
  });
});

describe("review", () => {
  it("a file row and a hunk have their own menus", async () => {
    press("2");
    await settle();
    const frow = $$(".frow").find((r) => r.closest("[data-section='proposed']"))!;
    rightClick(frow);
    await settle();
    expect(items()).toEqual(["Accept proposed hunks", "Open in editor", "Discard changes…", "Copy path"]);
    expect(item("Accept proposed hunks").textContent).toContain("Space");
    await closeMenu();

    const hunk = $$("article.hunk")[0];
    rightClick(hunk);
    await settle();
    expect(items()).toEqual(["Stage hunk", "Unstage hunk", "Reject proposal", "Edit by hand", "Copy hunk as patch"]);
    expect(item("Stage hunk").textContent).toContain("Y");
    expect(item("Reject proposal").textContent).toContain("N");
    expect(item("Edit by hand").textContent).toContain("E");
    const before = app.pending.length;
    item("Stage hunk").click();
    await settle();
    await vi.waitFor(() => expect(app.pending.length).toBe(before - 1));
  });

  it("Copy hunk as patch writes a unified diff", async () => {
    clip.mockClear();
    const hunk = $$("article.hunk")[0];
    rightClick(hunk);
    await settle();
    item("Copy hunk as patch").click();
    await settle();
    await vi.waitFor(() => expect(clip).toHaveBeenCalled());
    expect(clip.mock.calls[0][0]).toMatch(/^--- a\/.+\n\+\+\+ b\/.+\n@@ -\d+/);
  });

  it("Menu key opens the menu of the focused hunk when nothing else has the focus", async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    press("ContextMenu");
    await settle();
    expect(items()).toContain("Copy hunk as patch");
    press("Escape");
    await settle();
  });
});

describe("links", () => {
  it("a link in the sheet: Open, Copy URL, Remove", async () => {
    press("l");
    await settle();
    const pit = $$(".pit")[0];
    expect(pit).toBeTruthy();
    rightClick(pit);
    await settle();
    expect(items()).toEqual(["Open", "Copy URL", "Remove"]);
    await closeMenu();
    press("Escape");
    await settle();
  });
});

describe("the command bar", () => {
  it("finds the actions of the place under Here and runs one", async () => {
    press("1");
    await settle();
    app.openFile(app.active, "api/src/billing/webhook.ts", true);
    press("t", { ctrlKey: true });
    await settle();
    const input = $("#pal-in") as HTMLInputElement;
    input.value = "reveal worktree";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect($$(".psec").map((s) => s.textContent)).toEqual(["Here"]);
    const hit = $$(".pit").find((b) => b.textContent?.includes("Reveal worktree"))!;
    expect(hit).toBeTruthy();
    hit.click();
    await settle();
    expect(backend.revealed.at(-1)).toBeTruthy();
  });
});
