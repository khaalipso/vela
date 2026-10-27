// @vitest-environment jsdom
// The item list of each menu in representative states, and the confirmation flows, on the mock backend.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "./app.svelte";
import { MockBackend } from "./backend";
import { isItem, labels, type MenuAction, type MenuEntry } from "./contextmenu.svelte";
import { files } from "./files.svelte";
import { archivedMenu, contextPaletteItems, installMenus, editorMenu, hunkMenu, linkMenu, reviewFileMenu, repoChipMenu, spaceMenu, tabMenu, textFieldMenu, treeMenu } from "./menus";
import { ops } from "./ops.svelte";
import { buildTree, type TNode } from "./filetree";
import type { Hunk, Link } from "./types";

let backend: MockBackend;

const settle = () => new Promise((r) => setTimeout(r, 5));
const find = (m: MenuEntry[], label: string): MenuAction => {
  const x = m.filter(isItem).find((i) => i.label === label);
  if (!x) throw new Error(`no "${label}" in ${labels(m).join(" | ")}`);
  return x;
};
const has = (m: MenuEntry[], label: string) => m.filter(isItem).some((i) => i.label === label);

/** The node of the tree for a file, folder or repo. */
function node(kind: TNode["kind"], repo: string, path = ""): TNode {
  const prep = files.prepare(app.space.id)!;
  const walk = (ns: TNode[]): TNode | null => {
    for (const n of ns) {
      if (n.kind === kind && n.repo === repo && (kind === "repo" || n.path === path)) return n;
      const r = walk(n.children);
      if (r) return r;
    }
    return null;
  };
  const n = walk(buildTree(prep.repos));
  if (!n) throw new Error(`no ${kind} ${repo}/${path}`);
  return n;
}

async function boot(opts: { trash?: boolean } = {}) {
  backend = new MockBackend({ speed: 0, ...opts });
  localStorage.clear();
  await app.init(backend);
  app.sheet = null;
  app.overlay = null;
  await files.load(app.space.id);
  await settle();
}

beforeAll(async () => {
  await boot();
  installMenus();
});
beforeEach(() => {
  app.sheet = null;
  app.overlay = null;
  app.toastState = null;
});
afterAll(() => {
  app.destroy();
  files.stop();
});

describe("file menu", () => {
  it("a file with a staged change offers Unstage, no Stage", () => {
    // the seed stages api/src/billing/checkout.ts
    const n = node("file", "api", "src/billing/checkout.ts");
    expect(n.file?.staged).toBeTruthy();
    const m = treeMenu(n);
    expect(labels(m)).toEqual([
      "Open",
      "Open pinned",
      "-",
      "Unstage",
      "Discard changes…",
      "-",
      "Copy path",
      "Copy relative path",
      "Copy repo:path",
      "Reveal in file manager",
      "-",
      "Rename…",
      "Delete…",
      "-",
      "New file here",
      "New folder here",
      "Open terminal here",
      "Filter to this folder",
    ]);
    expect(find(m, "Unstage").shortcut).toBe("Space");
    expect(find(m, "Discard changes…").disabled).toMatch(/unstage/i);
    expect(find(m, "Discard changes…").danger).toBe(true);
    expect(find(m, "Delete…").danger).toBe(true);
  });

  it("a clean file can be staged only in name: Stage and Discard say why they are off", () => {
    const m = treeMenu(node("file", "api", "package.json"));
    expect(find(m, "Stage").disabled).toMatch(/No changes/);
    expect(find(m, "Discard changes…").disabled).toMatch(/No changes/);
    expect(has(m, "Unstage")).toBe(false);
    expect(find(m, "Filter to this folder").disabled).toMatch(/root/);
  });

  it("a file changed on both sides offers Stage and Unstage", () => {
    const m = treeMenu({ ...node("file", "api", "package.json"), file: { repo: "api", path: "package.json", staged: "modified", unstaged: "modified" } });
    expect(has(m, "Stage")).toBe(true);
    expect(has(m, "Unstage")).toBe(true);
    expect(find(m, "Discard changes…").disabled).toBe(false);
  });

  it("every file item reaches the backend through the same operations", async () => {
    const repo = "api";
    const path = "src/billing/checkout.ts";
    const m = treeMenu(node("file", repo, path));
    find(m, "Reveal in file manager").run!();
    find(m, "Open terminal here").run!();
    await settle();
    expect(backend.revealed).toContain("api/src/billing/checkout.ts");
    expect(backend.terminals).toContain("api/src/billing");
  });
});

describe("untracked file", () => {
  beforeEach(async () => {
    app.sheet = null;
    app.overlay = null;
  });

  it("is created, shows up untracked, and discarding it needs an explicit confirm", async () => {
    await backend.createFile(app.space.id, "api", "notes/todo.md");
    await app.refresh();
    await files.load(app.space.id);
    const n = node("file", "api", "notes/todo.md");
    expect(n.file?.unstaged).toBe("untracked");
    const m = treeMenu(n);
    expect(find(m, "Stage").disabled).toBe(false);
    find(m, "Discard changes…").run!();
    expect(app.overlay).toBe("sheet");
    const s = app.sheet!;
    expect(s.kind).toBe("confirm");
    if (s.kind !== "confirm") return;
    expect(s.title).toBe("Delete todo.md?");
    expect(s.body).toMatch(/git cannot bring it back/);
    expect(s.items).toEqual(["notes/todo.md"]);
    expect(s.danger).toBe(true);
    expect(s.ack).toMatch(/gone for good/);
    // the sheet itself holds the confirm button until the box is ticked (see the shell test);
    // running it removes the file for good
    await s.run();
    await files.load(app.space.id);
    expect(files.data[app.space.id].flatMap((r) => r.files).some((f) => f.path === "notes/todo.md")).toBe(false);
  });

  it("discarding a file you edited lists the hunks and restores the content", async () => {
    const sid = app.space.id;
    const before = (await backend.readFile(sid, "api", "package.json")).content;
    await backend.writeFile(sid, "api", "package.json", before + "\n// scribble");
    await app.refresh();
    await files.load(sid);
    const n = node("file", "api", "package.json");
    expect(n.file?.unstaged).toBe("modified");
    find(treeMenu(n), "Discard changes…").run!();
    const s = app.sheet!;
    expect(s.kind).toBe("confirm");
    if (s.kind !== "confirm") return;
    expect(s.title).toBe("Discard changes to package.json?");
    expect(s.ack).toBeUndefined();
    expect(s.items?.[0]).toMatch(/^package\.json:\d+ {2}\+\d+ −\d+$/);
    await s.run();
    expect((await backend.readFile(sid, "api", "package.json")).content).toBe(before);
    await files.load(sid);
    expect(node("file", "api", "package.json").file?.unstaged).toBeNull();
  });
});

describe("folder and repo menus", () => {
  it("a folder", () => {
    const m = treeMenu(node("dir", "api", "src/billing"));
    expect(labels(m)).toEqual([
      "New file",
      "New folder",
      "-",
      "Rename…",
      "Delete…",
      "-",
      "Collapse all inside",
      "Stage all inside",
      "Unstage all inside",
      "-",
      "Copy path",
      "Copy relative path",
      "Reveal in file manager",
      "Open terminal here",
      "Filter to this folder",
    ]);
    // the seed has staged and unstaged changes under src/billing
    expect(find(m, "Unstage all inside").disabled).toBe(false);
  });

  it("a folder without changes cannot stage or unstage, with the reason", () => {
    const m = treeMenu(node("dir", "web", [...new Set(files.prepare(app.space.id)!.entries.filter((e) => e.repo === "web" && !e.staged && !e.unstaged).map((e) => e.path.split("/").slice(0, -1).join("/")).filter(Boolean))][0]));
    expect(find(m, "Stage all inside").disabled).toMatch(/Nothing to stage/);
    expect(find(m, "Unstage all inside").disabled).toMatch(/Nothing staged/);
  });

  it("a repo node", () => {
    const m = treeMenu(node("repo", "api"));
    expect(labels(m)).toEqual([
      "Stage all",
      "Unstage all",
      "-",
      "Copy worktree path",
      "Reveal worktree",
      "Open terminal here",
      "-",
      "Remove repo from space",
    ]);
    expect(find(m, "Remove repo from space").disabled).toBe(false);
  });

  it("the only repo of a space cannot be removed", async () => {
    const solo = await backend.createSpace("Solo", ["api"]);
    await app.syncSpaces();
    app.goSpace(app.spaces.findIndex((s) => s.id === solo.id));
    expect(app.space.repos).toHaveLength(1);
    expect(find(repoChipMenu("api"), "Remove repo from space").disabled).toMatch(/at least one/);
    await backend.removeSpace(solo.id);
    await app.syncSpaces();
    app.goSpace(0);
  });

  it("Remove repo from space dispatches the existing action", async () => {
    app.goSpace(0);
    const spy = vi.spyOn(app, "removeRepo").mockResolvedValue();
    find(treeMenu(node("repo", "infra")), "Remove repo from space").run!();
    await settle();
    expect(spy).toHaveBeenCalledWith("infra");
    spy.mockRestore();
  });

  it("stage all inside a folder stages every changed file under it", async () => {
    app.goSpace(0);
    const sid = app.space.id;
    await files.load(sid);
    const orig = (await backend.readFile(sid, "api", "src/billing/checkout.ts")).content;
    await backend.writeFile(sid, "api", "src/billing/checkout.ts", orig + "\n// edit");
    await app.refresh();
    await files.load(sid);
    const before = ops.entriesIn("api", "src").filter((e) => e.unstaged).length;
    expect(before).toBeGreaterThan(0);
    await ops.stageInside("api", "src", true);
    await files.load(sid);
    expect(ops.entriesIn("api", "src").filter((e) => e.unstaged).length).toBe(0);
  });

  it("the top bar chip of a repo", () => {
    const m = repoChipMenu("api");
    expect(labels(m)).toEqual(["Show files", "-", "Copy worktree path", "Reveal worktree", "Open terminal here", "-", "Remove repo from space"]);
  });
});

describe("delete", () => {
  it("goes to the trash without asking", async () => {
    app.goSpace(0);
    const sid = app.space.id;
    await backend.createFile(sid, "api", "tmp/gone.txt");
    await app.refresh();
    await files.load(sid);
    await ops.askDelete("api", "tmp/gone.txt", false);
    expect(backend.trashed).toContain("api/tmp/gone.txt");
    expect(app.sheet).toBeNull();
    expect(app.toastState?.text).toBe("Moved gone.txt to the trash");
  });

  it("asks before deleting for good when there is no trash", async () => {
    await boot({ trash: false });
    const sid = app.space.id;
    await backend.createFile(sid, "api", "tmp/gone.txt");
    await app.refresh();
    await files.load(sid);
    await ops.askDelete("api", "tmp/gone.txt", false);
    expect(backend.trashed).toEqual([]);
    const s = app.sheet!;
    expect(s.kind).toBe("confirm");
    if (s.kind !== "confirm") return;
    expect(s.title).toBe("Delete gone.txt for good?");
    expect(s.body).toMatch(/no trash/);
    await s.run();
    await files.load(sid);
    expect(files.data[sid].flatMap((r) => r.files).some((f) => f.path === "tmp/gone.txt")).toBe(false);
    await boot();
  });

  it("deleting the open file closes its tab", async () => {
    const sid = app.space.id;
    await backend.createFile(sid, "api", "tmp/open.txt");
    await app.refresh();
    app.openFile(app.active, "api/tmp/open.txt", true);
    expect(app.cui.tabs.some((t) => t.key === "api/tmp/open.txt")).toBe(true);
    await ops.askDelete("api", "tmp/open.txt", false);
    expect(app.cui.tabs.some((t) => t.key === "api/tmp/open.txt")).toBe(false);
    expect(app.cui.file).not.toBe("api/tmp/open.txt");
  });
});

describe("inline rename and new file", () => {
  it("renames a file, keeping its tab and the open file", async () => {
    app.goSpace(0);
    const sid = app.space.id;
    await backend.createFile(sid, "api", "tmp/a.txt");
    await app.refresh();
    await files.load(sid);
    app.openFile(app.active, "api/tmp/a.txt", true);
    ops.startRename("api", "tmp/a.txt", false);
    expect(files.edit).toMatchObject({ mode: "rename", value: "a.txt", dir: "tmp" });
    files.edit!.value = "b.txt";
    await ops.commitEdit();
    expect(files.edit).toBeNull();
    expect(app.cui.file).toBe("api/tmp/b.txt");
    expect(app.cui.tabs.map((t) => t.key)).toContain("api/tmp/b.txt");
    expect(app.cui.tabs.map((t) => t.key)).not.toContain("api/tmp/a.txt");
  });

  it("keeps the input open with a message when the name is taken or invalid", async () => {
    const sid = app.space.id;
    await backend.createFile(sid, "api", "tmp/c.txt");
    await app.refresh();
    ops.startRename("api", "tmp/c.txt", false);
    files.edit!.value = "b.txt";
    await ops.commitEdit();
    expect(files.edit?.error).toMatch(/already exists/);
    files.edit!.value = "x/y";
    await ops.commitEdit();
    expect(files.edit?.error).toMatch(/slash/);
    ops.cancelEdit();
    expect(files.edit).toBeNull();
  });

  it("New file here creates the file in that folder and opens it", async () => {
    ops.startNew("file", "api", "tmp");
    expect(files.edit).toMatchObject({ mode: "file", dir: "tmp" });
    files.edit!.value = "fresh.md";
    await ops.commitEdit();
    expect(app.cui.file).toBe("api/tmp/fresh.md");
    await files.load(app.space.id);
    expect(node("file", "api", "tmp/fresh.md").file?.unstaged).toBe("untracked");
  });

  it("New folder reports that git lists it once it holds a file", async () => {
    ops.startNew("dir", "api", "tmp");
    files.edit!.value = "deeper";
    await ops.commitEdit();
    expect(app.toastState?.text).toMatch(/tmp\/deeper\/.*holds a file/);
  });

  it("an empty name cancels", async () => {
    ops.startNew("file", "api", "");
    files.edit!.value = "  ";
    await ops.commitEdit();
    expect(files.edit).toBeNull();
  });

  it("refuses to leave the worktree", async () => {
    ops.startNew("file", "api", "");
    files.edit!.value = "../evil.txt";
    await ops.commitEdit();
    expect(files.edit?.error).toBeTruthy();
    ops.cancelEdit();
    await expect(backend.createFile(app.space.id, "api", ".git/hooks/x")).rejects.toMatchObject({ kind: "forbidden_path" });
    await expect(backend.deletePath(app.space.id, "api", "/etc/passwd")).rejects.toMatchObject({ kind: "forbidden_path" });
  });
});

describe("tabs", () => {
  it("lists for a pinned tab, a preview tab and the only tab", () => {
    app.goSpace(0);
    app.cui.tabs = [
      { key: "api/a.ts", pinned: true },
      { key: "api/b.ts", pinned: false },
    ];
    const pinned = tabMenu("api/a.ts");
    expect(labels(pinned)).toEqual(["Close", "Close others", "Close to the right", "Close all", "-", "Unpin", "-", "Copy path", "Reveal in tree"]);
    expect(find(pinned, "Close to the right").disabled).toBe(false);
    const preview = tabMenu("api/b.ts");
    expect(has(preview, "Pin")).toBe(true);
    expect(find(preview, "Close to the right").disabled).toMatch(/No tabs/);
    app.cui.tabs = [{ key: "api/a.ts", pinned: true }];
    expect(find(tabMenu("api/a.ts"), "Close others").disabled).toMatch(/only tab/);
  });

  it("close others, close to the right, close all and pin", () => {
    app.cui.tabs = [
      { key: "api/a.ts", pinned: true },
      { key: "api/b.ts", pinned: true },
      { key: "api/c.ts", pinned: true },
    ];
    app.cui.file = "api/c.ts";
    find(tabMenu("api/a.ts"), "Close to the right").run!();
    expect(app.cui.tabs.map((t) => t.key)).toEqual(["api/a.ts"]);
    expect(app.cui.file).toBe("api/a.ts");
    app.cui.tabs = [
      { key: "api/a.ts", pinned: true },
      { key: "api/b.ts", pinned: true },
    ];
    find(tabMenu("api/b.ts"), "Close others").run!();
    expect(app.cui.tabs.map((t) => t.key)).toEqual(["api/b.ts"]);
    find(tabMenu("api/b.ts"), "Unpin").run!();
    expect(app.cui.tabs[0].pinned).toBe(false);
    find(tabMenu("api/b.ts"), "Close all").run!();
    expect(app.cui.tabs).toEqual([]);
    expect(app.cui.file).toBe("");
  });
});

describe("editor menu", () => {
  const info = (over: Partial<Parameters<typeof editorMenu>[0]> = {}) => ({
    key: "api/src/billing/checkout.ts",
    line: 12,
    lastLine: 40,
    selection: false,
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    ...over,
  });

  it("lists clipboard items, then the file actions", () => {
    const m = editorMenu(info());
    expect(labels(m)).toEqual(["Cut", "Copy", "Paste", "Select all", "-", "Copy link to line", "Go to line…", "Reveal in tree", "Stage this file"]);
    expect(find(m, "Cut").disabled).toMatch(/Select some text/);
    expect(find(m, "Copy").disabled).toMatch(/Select some text/);
    expect(find(m, "Paste").disabled).toBeFalsy();
    expect(find(m, "Stage this file").disabled).toMatch(/Already staged/);
  });

  it("a selection enables Cut and Copy and runs the editor calls", () => {
    const i = info({ selection: true });
    const m = editorMenu(i);
    find(m, "Cut").run!();
    find(m, "Copy").run!();
    find(m, "Paste").run!();
    find(m, "Select all").run!();
    expect(i.cut).toHaveBeenCalled();
    expect(i.copy).toHaveBeenCalled();
    expect(i.paste).toHaveBeenCalled();
    expect(i.selectAll).toHaveBeenCalled();
  });

  it("Copy link to line writes repo/path:line, Go to line opens a prompt sheet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const m = editorMenu(info());
    find(m, "Copy link to line").run!();
    await settle();
    expect(writeText).toHaveBeenCalledWith("api/src/billing/checkout.ts:12");
    find(m, "Go to line…").run!();
    const s = app.sheet!;
    expect(s.kind).toBe("prompt");
    if (s.kind !== "prompt") return;
    expect(s.validate!("abc")).toBeTruthy();
    expect(s.validate!("0")).toBeTruthy();
    expect(s.validate!("12")).toBeNull();
    await s.run("999");
    expect(app.focusRequest).toMatchObject({ file: "api/src/billing/checkout.ts", line: 40 });
    app.closeOverlay();
  });
});

describe("review menus", () => {
  it("file rows: accept or take back, reject the agent's part, discard only your own", () => {
    const done = reviewFileMenu({ section: "done", repo: "api", path: "a.ts", agents: [], mine: false });
    expect(labels(done)).toEqual(["Back to review", "Reject the agent's changes", "Open in editor", "-", "Discard your changes…", "-", "Copy path"]);
    expect(find(done, "Back to review").shortcut).toBe("Space");
    expect(find(done, "Discard your changes…").disabled).toMatch(/back to review first/);
    const mine = reviewFileMenu({ section: "review", repo: "api", path: "a.ts", agents: [], mine: true });
    expect(has(mine, "Accept file")).toBe(true);
    expect(find(mine, "Discard your changes…").disabled).toBe(false);
    expect(find(mine, "Reject the agent's changes").disabled).toMatch(/No proposal/);
    const prop = reviewFileMenu({ section: "review", repo: "api", path: "a.ts", agents: ["developer-1"], mine: false });
    expect(find(prop, "Reject the agent's changes").disabled).toBe(false);
    expect(find(prop, "Discard your changes…").disabled).toMatch(/Nothing of yours/);
  });

  const hunk = (over: Partial<Hunk>): Hunk => ({
    id: "h",
    repo: "api",
    path: "a.ts",
    oldStart: 3,
    oldLines: 1,
    newStart: 3,
    newLines: 1,
    section: "",
    lines: [],
    origin: { type: "agent", agent: "stripe-dev" },
    state: "pending",
    ...over,
  });

  it("a pending agent proposal can be staged, rejected and edited", () => {
    const m = hunkMenu(hunk({}));
    expect(labels(m)).toEqual(["Accept change", "Back to review", "Reject change", "Edit by hand", "-", "Copy as patch"]);
    expect(find(m, "Accept change").shortcut).toBe("Y");
    expect(find(m, "Back to review").shortcut).toBe("U");
    expect(find(m, "Reject change").shortcut).toBe("N");
    expect(find(m, "Edit by hand").shortcut).toBe("E");
    expect(find(m, "Accept change").disabled).toBe(false);
    expect(find(m, "Back to review").disabled).toMatch(/Not accepted/);
    expect(find(m, "Reject change").disabled).toBe(false);
  });

  it("your own staged hunk can be unstaged but never rejected", () => {
    const m = hunkMenu(hunk({ origin: { type: "you" }, state: "staged" }));
    expect(find(m, "Accept change").disabled).toMatch(/Already accepted/);
    expect(find(m, "Back to review").disabled).toBe(false);
    expect(find(m, "Reject change").disabled).toMatch(/never discarded/);
  });

  it("a staged proposal cannot be rejected any more", () => {
    expect(find(hunkMenu(hunk({ state: "staged" })), "Reject change").disabled).toMatch(/pending/);
  });
});

describe("space menus", () => {
  beforeEach(() => {
    app.goSpace(0);
  });

  it("lists the actions of a space, with the current color checked", () => {
    const m = spaceMenu(0);
    expect(labels(m)).toEqual(["Rename…", "Change color", "Open in its own window", "Copy branch name", "-", "Archive", "Remove space…"]);
    expect(find(m, "Open in its own window").shortcut).toBe("W");
    const colors = find(m, "Change color").submenu!.filter(isItem);
    expect(colors.map((c) => c.label)).toEqual(["Amber", "Sky", "Violet", "Green", "Pink", "Mint"]);
    const current = colors.filter((c) => c.checked);
    expect(current).toHaveLength(1);
    expect(current[0].swatch?.toLowerCase()).toBe(app.spaces[0].color.toLowerCase());
    expect(find(m, "Remove space…").danger).toBe(true);
  });

  it("an archived space can be restored or removed", () => {
    const m = archivedMenu(app.spaces[0]);
    expect(labels(m)).toEqual(["Restore", "Copy branch name", "-", "Remove space…"]);
  });

  it("Rename… asks for a name, then renames", async () => {
    find(spaceMenu(0), "Rename…").run!();
    const s = app.sheet!;
    expect(s.kind).toBe("prompt");
    if (s.kind !== "prompt") return;
    expect(s.value).toBe(app.spaces[0].name);
    expect(s.validate!("  ")).toBeTruthy();
    await s.run("Billing rewrite");
    expect(app.spaces[0].name).toBe("Billing rewrite");
    app.closeOverlay();
  });

  it("Change color writes the swatch", async () => {
    const sky = find(find(spaceMenu(0), "Change color").submenu!.filter(isItem) as unknown as MenuEntry[], "Sky");
    sky.run!();
    await settle();
    expect(app.spaces[0].color).toBe("#7DB8F5");
    const again = find(find(spaceMenu(0), "Change color").submenu!.filter(isItem) as unknown as MenuEntry[], "Sky");
    expect(again.checked).toBe(true);
  });

  it("Archive hides the space and lists it under Archived; Restore brings it back", async () => {
    const id = app.spaces[1].id;
    const n = app.spaces.length;
    find(spaceMenu(1), "Archive").run!();
    await settle();
    await vi.waitFor(() => expect(app.archived.map((s) => s.id)).toEqual([id]));
    expect(app.spaces.length).toBe(n - 1);
    expect(app.spaces.some((s) => s.id === id)).toBe(false);
    find(archivedMenu(app.archived[0]), "Restore").run!();
    await vi.waitFor(() => expect(app.archived).toEqual([]));
    expect(app.spaces.some((s) => s.id === id)).toBe(true);
  });

  it("the last space cannot be archived", async () => {
    const saved = app.spaces;
    app.spaces = saved.slice(0, 1);
    expect(find(spaceMenu(0), "Archive").disabled).toMatch(/another/);
    app.spaces = saved;
  });

  it("Remove space… explains what happens to worktrees and branches, then removes it", async () => {
    const id = app.spaces[2].id;
    find(spaceMenu(2), "Remove space…").run!();
    const s = app.sheet!;
    expect(s.kind).toBe("confirm");
    if (s.kind !== "confirm") return;
    expect(s.body).toMatch(/worktrees of this space are removed/);
    expect(s.body).toMatch(/unmerged commits stays/);
    expect(s.danger).toBe(true);
    expect(s.confirmLabel).toBe("Remove space");
    await s.run();
    expect(app.spaces.some((x) => x.id === id)).toBe(false);
    expect(app.active).toBeLessThan(app.spaces.length);
  });
});

describe("links", () => {
  const link = (over: Partial<Link>): Link => ({ id: "l", kind: "doc", provider: "url", url: "https://x.test/a", title: "A doc", source: "manual", ...over });

  it("a manual link can be opened, copied and removed", () => {
    const m = linkMenu(link({}));
    expect(labels(m)).toEqual(["Open", "Copy URL", "Remove"]);
    expect(find(m, "Remove").disabled).toBe(false);
  });

  it("a detected link cannot be removed, a key without URL cannot be opened", () => {
    const m = linkMenu(link({ source: "branch", url: "", kind: "issue", key: "PAY-1" }));
    expect(find(m, "Remove").disabled).toMatch(/history/);
    expect(find(m, "Open").disabled).toMatch(/tracker URL/);
    expect(find(m, "Copy URL").disabled).toMatch(/tracker URL/);
    expect(find(linkMenu(link({ source: "repo" })), "Remove").disabled).toMatch(/links\.toml/);
  });

  it("Remove drops a manual link from the space", async () => {
    app.goSpace(0);
    const l = await backend.addLink(app.space.id, "https://x.test/menu", "Menu doc");
    await app.refresh();
    find(linkMenu(l), "Remove").run!();
    await settle();
    expect(app.sd.links.some((x) => x.id === l.id)).toBe(false);
  });
});

describe("text fields", () => {
  it("Cut, Copy, Paste and Select all, with Cut and Copy off without a selection", () => {
    const input = document.createElement("input");
    input.value = "hello world";
    document.body.appendChild(input);
    input.setSelectionRange(0, 0);
    const m = textFieldMenu(input);
    expect(labels(m)).toEqual(["Cut", "Copy", "Paste", "Select all"]);
    expect(find(m, "Cut").disabled).toBeTruthy();
    input.setSelectionRange(0, 5);
    expect(find(textFieldMenu(input), "Copy").disabled).toBe(false);
    input.remove();
  });

  it("Paste inserts the clipboard text and tells Svelte through an input event", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { readText: vi.fn().mockResolvedValue("XY"), writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    const input = document.createElement("input");
    input.value = "abcd";
    document.body.appendChild(input);
    input.setSelectionRange(1, 3);
    const seen = vi.fn();
    input.addEventListener("input", seen);
    find(textFieldMenu(input), "Paste").run!();
    await settle();
    expect(input.value).toBe("aXYd");
    expect(seen).toHaveBeenCalled();
    input.remove();
  });
});

describe("the command bar", () => {
  it("offers the actions of the current file, space and repos under Here", () => {
    app.goSpace(0);
    app.ui[app.space.id].view = "code";
    app.openFile(0, "api/src/billing/webhook.ts", true);
    const items = contextPaletteItems();
    expect(items.every((i) => i.sec === "Here")).toBe(true);
    const titles = items.map((i) => i.title);
    for (const t of [
      "Copy path",
      "Reveal in file manager",
      "Rename…",
      "Delete…",
      "Close others",
      "Unpin",
      "Go to line…",
      "Reveal in tree",
      "Rename…",
      "Change color: Sky",
      "Archive",
      "Remove space…",
      "Copy branch name",
      "Reveal worktree",
      "Open terminal here",
      "Remove repo from space",
    ]) {
      expect(titles, t).toContain(t);
    }
    // what the command bar already has is not repeated, disabled items are left out
    expect(titles).not.toContain("Open in its own window");
    expect(titles).not.toContain("Discard changes…");
    // a repo's items say which repo
    expect(items.find((i) => i.title === "Reveal worktree")?.sub).toBeTruthy();
  });

  it("is part of app.paletteItems, right after the actions, and runs", async () => {
    app.pal = { q: "", i: 0 };
    const all = app.paletteItems;
    const secs = all.map((i) => i.sec).filter((s, i, a) => a.indexOf(s) === i);
    expect(secs.slice(0, 2)).toEqual(["Actions", "Here"]);
    app.pal = { q: "branch name", i: 0 };
    const hit = app.paletteItems.find((i) => i.title === "Copy branch name");
    expect(hit?.run).toBeTypeOf("function");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    app.runPalette(hit);
    await settle();
    expect(writeText).toHaveBeenCalledWith(app.space.branch);
    app.pal = { q: "", i: 0 };
  });

  it("in the review view it offers the selected file and the hunk under the cursor", () => {
    app.goSpace(0);
    app.setView("review");
    const titles = contextPaletteItems().map((i) => i.title);
    expect(titles).toContain("Copy as patch");
    expect(titles).toContain("Open in editor");
  });
});
