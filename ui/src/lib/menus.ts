// The lists of the right-click menus, one builder per place. A builder reads the current state
// and returns entries whose `run` call the operations in ops.svelte.ts or dispatch an `Action`;
// the shortcut written on an item is found through the keymap, never typed by hand.
// The same lists feed the command bar ("Here"), so nothing exists only behind a right click.

import { app } from "./app.svelte";
import { contextMenuAt, isItem, openAtEvent, SEP, tidy, type MenuAction, type MenuEntry } from "./contextmenu.svelte";
import { files } from "./files.svelte";
import type { FileEntry, TNode } from "./filetree";
import { fileKey } from "./format";
import { shortcutFor, type Action, type View } from "./keymap";
import type { PaletteItem } from "./palette";
import { ops, readClipboard, SPACE_COLORS, splitKey, writeClipboard, basename, dirname } from "./ops.svelte";
import type { FileRow } from "./review";
import type { Hunk, Link, Space } from "./types";
import { repoBranch, spaceBranches } from "./types";

type Part = Omit<MenuAction, "id"> & { id?: string };

/** An item; the id defaults to the label, which is what tests and the command bar address. */
const it = (label: string, p: Omit<Part, "label"> = {}): MenuAction => ({ id: p.id ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), label, ...p });

/** An item that dispatches an action; its shortcut comes from the keymap. */
const act = (label: string, action: Action, view: View, p: Omit<Part, "label" | "shortcut"> = {}): MenuAction =>
  it(label, { run: () => void app.dispatch(action), ...p, shortcut: shortcutFor(action, view) });

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

const hasChange = (e: Pick<FileEntry, "staged" | "unstaged">) => !!(e.staged || e.unstaged);

/** Menu of a row of the file tree: a file, a folder (maybe a compacted chain) or a repo. */
export function treeMenu(n: TNode): MenuEntry[] {
  if (n.kind === "file") return fileMenu(n.file!);
  if (n.kind === "repo") return repoNodeMenu(n.repo);
  return folderMenu(n);
}

function fileMenu(e: FileEntry): MenuEntry[] {
  const { repo, path } = e;
  const dir = dirname(path);
  const fullyStaged = !!e.staged && !e.unstaged;
  const clean = !hasChange(e);
  return tidy([
    it("Open", { shortcut: "Enter", icon: "open", run: () => ops.open(repo, path, false) }),
    it("Open pinned", { icon: "pin", run: () => ops.open(repo, path, true) }),
    SEP,
    fullyStaged
      ? null
      : it("Stage", { shortcut: "Space", icon: "stage", disabled: clean ? "No changes in this file" : false, run: () => void ops.stage(repo, path) }),
    e.staged ? it("Unstage", { shortcut: fullyStaged ? "Space" : undefined, icon: "unstage", run: () => void ops.unstage(repo, path) }) : null,
    it("Discard changes…", {
      icon: "discard",
      danger: true,
      disabled: e.unstaged ? false : e.staged ? "Only staged changes: unstage them first" : "No changes to discard",
      run: () => ops.askDiscard(repo, path),
    }),
    SEP,
    it("Copy path", { icon: "copy", run: () => void ops.copyAbsolute(repo, path) }),
    it("Copy relative path", { icon: "copy", run: () => void ops.copyRelative(path) }),
    it("Copy repo:path", { icon: "copy", run: () => void ops.copyRepoPath(repo, path) }),
    it("Reveal in file manager", { icon: "reveal", run: () => void ops.reveal(repo, path) }),
    SEP,
    it("Rename…", { shortcut: "F2", icon: "rename", run: () => ops.startRename(repo, path, false) }),
    it("Delete…", { shortcut: "Delete", icon: "trash", danger: true, run: () => void ops.askDelete(repo, path, false) }),
    SEP,
    it("New file here", { icon: "newfile", run: () => ops.startNew("file", repo, dir) }),
    it("New folder here", { icon: "newfolder", run: () => ops.startNew("dir", repo, dir) }),
    it("Open terminal here", { icon: "terminal", run: () => void ops.terminal(repo, path) }),
    it("Filter to this folder", {
      icon: "filter",
      disabled: dir ? false : "This file is at the root of the repo",
      run: () => ops.filterToFolder(repo, dir),
    }),
  ]);
}

function folderMenu(n: TNode): MenuEntry[] {
  const { repo, path } = n;
  const inside = ops.entriesIn(repo, path);
  const toStage = inside.filter((e) => e.unstaged).length;
  const toUnstage = inside.filter((e) => e.staged).length;
  return tidy([
    it("New file", { icon: "newfile", run: () => ops.startNew("file", repo, path) }),
    it("New folder", { icon: "newfolder", run: () => ops.startNew("dir", repo, path) }),
    SEP,
    it("Rename…", { shortcut: "F2", icon: "rename", run: () => ops.startRename(repo, path, true) }),
    it("Delete…", { shortcut: "Delete", icon: "trash", danger: true, run: () => void ops.askDelete(repo, path, true) }),
    SEP,
    it("Collapse all inside", { icon: "collapse", run: () => ops.collapseInside(repo, path) }),
    it("Stage all inside", { icon: "stage", disabled: toStage ? false : "Nothing to stage in this folder", run: () => void ops.stageInside(repo, path, true) }),
    it("Unstage all inside", { icon: "unstage", disabled: toUnstage ? false : "Nothing staged in this folder", run: () => void ops.stageInside(repo, path, false) }),
    SEP,
    it("Copy path", { icon: "copy", run: () => void ops.copyAbsolute(repo, path) }),
    it("Copy relative path", { icon: "copy", run: () => void ops.copyRelative(path) }),
    it("Reveal in file manager", { icon: "reveal", run: () => void ops.reveal(repo, path) }),
    it("Open terminal here", { icon: "terminal", run: () => void ops.terminal(repo, path) }),
    it("Filter to this folder", { icon: "filter", run: () => ops.filterToFolder(repo, path) }),
  ]);
}

function repoNodeMenu(repo: string): MenuEntry[] {
  return tidy([
    it("Stage all", {
      icon: "stage",
      disabled: ops.entriesIn(repo).some((e) => e.unstaged) ? false : "Nothing to stage in this repo",
      run: () => void ops.stageInside(repo, "", true),
    }),
    it("Unstage all", {
      icon: "unstage",
      disabled: ops.entriesIn(repo).some((e) => e.staged) ? false : "Nothing staged in this repo",
      run: () => void ops.stageInside(repo, "", false),
    }),
    SEP,
    ...repoItems(repo),
  ]);
}

/** Copy, reveal, terminal and remove for one repo: shared by the tree node and the top bar chip. */
function repoItems(repo: string): MenuEntry[] {
  const only = app.space.repos.length < 2;
  const r = app.space.repos.find((x) => x.name === repo);
  const old = !!r && r.worktree !== r.source;
  return [
    it("Copy path", { icon: "copy", run: () => void ops.copyAbsolute(repo, "") }),
    it("Reveal in file manager", { icon: "reveal", run: () => void ops.reveal(repo, "") }),
    it("Open terminal here", { icon: "terminal", run: () => void ops.terminal(repo, "") }),
    ...(old ? [act("Work in my clone", { type: "move-repo-into-clone", repo }, "code", { icon: "reveal" })] : []),
    SEP,
    act("Remove repo from space", { type: "remove-repo", repo }, "code", {
      icon: "close",
      danger: true,
      disabled: only ? "A space needs at least one repo" : false,
    }),
  ];
}

/** The branch items of one repo. */
function repoBranchItems(repo: string, named: boolean): MenuEntry[] {
  const b = repoBranch(app.space, repo);
  const of = named ? ` of ${repo}` : "";
  return [
    it(`Rename branch${of}…`, { icon: "rename", run: () => ops.askRenameBranch(repo) }),
    it(named ? `Copy ${b}` : "Copy branch name", { icon: "copy", run: () => void writeClipboard(b).then(() => app.toast(`Copied ${b}`)) }),
    it(`Push ${named ? b : "branch"}`, { run: () => void app.pushBranch(repo) }),
  ];
}

/** The branches of the space, from the branch chip in the top bar: the same branch in every
 *  repo acts on all of them; different branches get items per repo. */
export function branchMenu(): MenuEntry[] {
  const space = app.space;
  const branches = spaceBranches(space);
  if (branches.length === 1) {
    const b = branches[0];
    const many = space.repos.length > 1;
    return tidy([
      it(many ? "Rename in every repo…" : "Rename branch…", { icon: "rename", run: () => ops.askRenameBranch() }),
      it("Copy branch name", { icon: "copy", run: () => void writeClipboard(b).then(() => app.toast(`Copied ${b}`)) }),
      SEP,
      it(many ? "Push every repo" : "Push branch", { run: () => void app.pushBranch() }),
      ...(many ? [SEP, ...space.repos.map((r) => it(`Rename only in ${r.name}…`, { run: () => ops.askRenameBranch(r.name) }))] : []),
      SEP,
      it("Pull requests", { run: () => app.setView("prs") }),
    ]);
  }
  return tidy([
    ...space.repos.flatMap((r) => [...repoBranchItems(r.name, true), SEP]),
    it("Pull requests", { run: () => app.setView("prs") }),
  ]);
}

/** The repo chips of the top bar. */
export function repoChipMenu(repo: string): MenuEntry[] {
  return tidy([
    it("Show files", { icon: "tree", run: () => ops.showRepoFiles(repo) }),
    SEP,
    ...repoBranchItems(repo, false),
    SEP,
    ...repoItems(repo),
  ]);
}

/** The ticket chip of the top bar. */
export function ticketMenu(): MenuEntry[] {
  const t = app.space.ticket;
  const link = app.sd.links.find((l) => l.source === "ticket");
  if (!t) return tidy([it("Set ticket…", { icon: "rename", run: () => ops.askTicket() })]);
  return tidy([
    it("Change ticket…", { icon: "rename", run: () => ops.askTicket() }),
    it(`Copy ${t}`, { icon: "copy", run: () => void writeClipboard(t).then(() => app.toast(`Copied ${t}`)) }),
    it("Open in the tracker", { disabled: link?.url ? false : "No tracker URL configured ([issues] jira in config.toml)", run: () => link && void app.openLink(link.id) }),
    SEP,
    it("Remove ticket", { icon: "close", danger: true, run: () => void app.setTicket("") }),
  ]);
}

// ---------------------------------------------------------------------------
// Editor tabs and the editor itself
// ---------------------------------------------------------------------------

export function tabMenu(key: string): MenuEntry[] {
  const tabs = app.cui.tabs;
  const at = tabs.findIndex((t) => t.key === key);
  const tab = tabs[at];
  const { repo, path } = splitKey(key);
  return tidy([
    it("Close", { icon: "close", run: () => ops.closeTab(key) }),
    it("Close others", { disabled: tabs.length > 1 ? false : "This is the only tab", run: () => ops.closeOtherTabs(key) }),
    it("Close to the right", { disabled: at >= 0 && at < tabs.length - 1 ? false : "No tabs to the right", run: () => ops.closeTabsToRight(key) }),
    it("Close all", { run: () => ops.closeAllTabs() }),
    SEP,
    it(tab?.pinned === false ? "Pin" : "Unpin", { icon: "pin", run: () => ops.togglePin(key) }),
    SEP,
    it("Copy path", { icon: "copy", run: () => void ops.copyAbsolute(repo, path) }),
    it("Reveal in tree", { icon: "tree", run: () => void ops.revealInTree(key) }),
  ]);
}

/** What the editor knows about the place that was clicked. */
export interface EditorInfo {
  key: string;
  /** Absolute number of the line under the pointer (or the cursor). */
  line: number;
  /** Lines in the file, for the go to line sheet. */
  lastLine?: number;
  selection: boolean;
  /** Clipboard and edit calls into CodeMirror, set by the editor. */
  cut: () => void;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
}

export function editorMenu(i: EditorInfo): MenuEntry[] {
  const { repo, path } = splitKey(i.key);
  const c = app.sd.status.find((s) => s.repo === repo && s.path === path);
  return tidy([
    it("Cut", { shortcut: "Ctrl X", icon: "cut", disabled: i.selection ? false : "Select some text first", run: i.cut }),
    it("Copy", { shortcut: "Ctrl C", icon: "copy", disabled: i.selection ? false : "Select some text first", run: i.copy }),
    it("Paste", { shortcut: "Ctrl V", icon: "paste", run: i.paste }),
    it("Select all", { shortcut: "Ctrl A", icon: "selectall", run: i.selectAll }),
    SEP,
    it("Copy link to line", { icon: "link", run: () => void ops.copyLineLink(i.key, i.line) }),
    it("Go to line…", { icon: "line", run: () => ops.askGoToLine(i.key, i.lastLine) }),
    it("Reveal in tree", { icon: "tree", run: () => void ops.revealInTree(i.key) }),
    it("Stage this file", {
      icon: "stage",
      disabled: !c ? "No changes in this file" : c.unstaged ? false : "Already staged",
      run: () => void ops.stage(repo, path),
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Review view
// ---------------------------------------------------------------------------

export function reviewFileMenu(r: Pick<FileRow, "section" | "repo" | "path" | "agents" | "mine">): MenuEntry[] {
  const row = () => app.rows.find((x) => x.repo === r.repo && x.path === r.path);
  const toggle =
    r.section === "done"
      ? it("Back to review", { shortcut: shortcutFor({ type: "rv-toggle-file" }, "review"), icon: "unstage", run: () => void app.dispatch({ type: "rv-toggle-file" }) })
      : it("Accept file", { shortcut: shortcutFor({ type: "rv-toggle-file" }, "review"), icon: "stage", run: () => void app.dispatch({ type: "rv-toggle-file" }) });
  return tidy([
    toggle,
    it("Reject the agent's changes", {
      shortcut: shortcutFor({ type: "rv-reject-file" }, "review"),
      icon: "discard",
      disabled: r.agents.length ? false : "No proposal of an agent in this file",
      run: () => {
        const x = row();
        if (x) void app.rvRejectRow(x);
      },
    }),
    it("Open in editor", { icon: "open", run: () => ops.open(r.repo, r.path, true) }),
    SEP,
    it("Discard your changes…", {
      icon: "discard",
      danger: true,
      disabled: r.mine ? false : r.section === "done" ? "Take it back to review first, then discard" : "Nothing of yours to discard",
      run: () => ops.askDiscard(r.repo, r.path),
    }),
    SEP,
    it("Copy path", { icon: "copy", run: () => void ops.copyAbsolute(r.repo, r.path) }),
  ]);
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

export function spaceMenu(index: number): MenuEntry[] {
  const s = app.spaces[index];
  if (!s) return [];
  const sole = app.spaces.length < 2;
  const inWindow = (s.window ?? null) !== null;
  return tidy([
    it("Rename…", { icon: "rename", run: () => ops.askRenameSpace(s) }),
    it("Change color", {
      icon: "palette",
      submenu: SPACE_COLORS.map((c) =>
        it(c.name, { id: `color-${c.name.toLowerCase()}`, swatch: c.hex, checked: s.color.toLowerCase() === c.hex.toLowerCase(), run: () => void ops.setColor(s, c.hex) }),
      ),
    }),
    it(inWindow ? "Bring back to this window" : "Open in its own window", {
      icon: "window",
      shortcut: shortcutFor({ type: "toggle-window" }, "code"),
      palette: false,
      run: () => {
        app.goSpace(index);
        void app.toggleWindow();
      },
    }),
    it("Copy branch name", { icon: "branch", run: () => void ops.copyBranch(s) }),
    SEP,
    it("Archive", {
      icon: "archive",
      disabled: app.pinned ? "Archive from the main window" : sole ? "Keep one space open: create another first" : false,
      run: () => void ops.archive(s),
    }),
    it("Remove space…", { icon: "trash", danger: true, run: () => ops.askRemoveSpace(s) }),
  ]);
}

export function archivedMenu(s: Space): MenuEntry[] {
  return tidy([
    it("Restore", { icon: "restore", run: () => void ops.restore(s) }),
    it("Copy branch name", { icon: "branch", run: () => void ops.copyBranch(s) }),
    SEP,
    it("Remove space…", { icon: "trash", danger: true, run: () => ops.askRemoveSpace(s) }),
  ]);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export function linkMenu(l: Link): MenuEntry[] {
  return tidy([
    it("Open", { shortcut: "Enter", icon: "open", disabled: l.url ? false : "No tracker URL configured for this key", run: () => void app.openLink(l.id) }),
    it("Copy URL", { icon: "copy", disabled: l.url ? false : "No tracker URL configured for this key", run: () => void ops.copyUrl(l) }),
  ]);
}

// ---------------------------------------------------------------------------
// Text fields
// ---------------------------------------------------------------------------

export type TextField = HTMLInputElement | HTMLTextAreaElement;

const NON_TEXT = new Set(["checkbox", "radio", "button", "submit", "range", "color", "file", "image", "reset"]);

export function isTextField(t: EventTarget | null): t is TextField {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLTextAreaElement) return true;
  return t instanceof HTMLInputElement && !NON_TEXT.has(t.type);
}

/** Cut, copy, paste and select all for an input or a textarea. */
export function textFieldMenu(el: TextField): MenuEntry[] {
  const a = el.selectionStart ?? 0;
  const b = el.selectionEnd ?? 0;
  const some = b > a;
  const ro = el.readOnly || el.disabled;
  const edit = (insert: string) => {
    el.focus();
    el.setRangeText(insert, a, b, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return tidy([
    it("Cut", { shortcut: "Ctrl X", icon: "cut", disabled: ro ? "This field is read only" : some ? false : "Select some text first", run: () => void writeClipboard(el.value.slice(a, b)).then(() => edit("")) }),
    it("Copy", { shortcut: "Ctrl C", icon: "copy", disabled: some ? false : "Select some text first", run: () => void writeClipboard(el.value.slice(a, b)) }),
    it("Paste", {
      shortcut: "Ctrl V",
      icon: "paste",
      disabled: ro ? "This field is read only" : false,
      run: () =>
        void readClipboard().then((t) => {
          if (t === null) app.toast("Press Ctrl V to paste here");
          else edit(t);
        }),
    }),
    it("Select all", { shortcut: "Ctrl A", icon: "selectall", run: () => { el.focus(); el.select(); } }),
  ]);
}

// ---------------------------------------------------------------------------
// The command bar and the keyboard
// ---------------------------------------------------------------------------

/** Items that are not worth a second line in the command bar (it already has them). */
function flatten(entries: MenuEntry[], sub: string | undefined, out: PaletteItem[], prefix = "") {
  for (const e of entries) {
    if (!isItem(e) || e.disabled || e.palette === false) continue;
    if (e.submenu) {
      flatten(e.submenu, sub, out, `${e.label}: `);
      continue;
    }
    out.push({ sec: "Here", title: `${prefix}${e.label}`, sub, key: e.shortcut, run: e.run });
  }
}

/** The actions of the place you are in, for the command bar. */
export function contextPaletteItems(): PaletteItem[] {
  if (!app.ready || !app.spaces.length) return [];
  const out: PaletteItem[] = [];
  const sid = app.space.id;
  const seen = new Set<string>();
  const add = (entries: MenuEntry[], sub: string, skip: string[] = []) => {
    const batch: PaletteItem[] = [];
    flatten(entries.filter((e) => !isItem(e) || !skip.includes(e.id)), sub, batch);
    for (const p of batch) {
      const k = `${p.title}\u0000${p.sub}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(p);
      }
    }
  };

  if (app.view === "review") {
    const r = app.selectedRow;
    if (r) add(reviewFileMenu(r), `${r.repo}/${r.path}`);
  }
  const key = app.cui.file;
  if (app.view === "code" && key) {
    const { repo, path } = splitKey(key);
    const entry = files.prepare(sid)?.entries.find((e) => e.repo === repo && e.path === path) ?? { repo, path, staged: null, unstaged: null };
    add(fileMenu(entry), key, ["open", "open-pinned"]);
    add(tabMenu(key), key);
    add(
      [
        it("Go to line…", { run: () => ops.askGoToLine(key) }),
        it("Reveal in tree", { run: () => void ops.revealInTree(key) }),
      ],
      key,
    );
  }
  // A folder or repo under the tree cursor.
  const cur = files.cursor;
  if (app.filesOpen && cur) {
    const node = cursorNode(cur);
    if (node && node.kind !== "file") add(treeMenu(node), node.kind === "repo" ? node.repo : `${node.repo}/${node.path}`);
  }
  add(spaceMenu(app.active), app.space.name);
  add(branchMenu(), spaceBranches(app.space).join(", "));
  add(ticketMenu(), app.space.ticket ?? "Ticket");
  for (const r of app.space.repos) add(repoChipMenu(r.name), r.name);
  for (const l of app.sd.links) add(linkMenu(l), l.title);
  for (const s of app.archived) add(archivedMenu(s), s.name);
  return out;
}

/** The folder or repo node a tree cursor id points at, without building the whole tree. */
function cursorNode(id: string): TNode | null {
  const m = /^([rdf]):(.*)$/.exec(id);
  if (!m) return null;
  const [, kind, rest] = m;
  if (kind === "r") return { id, kind: "repo", name: rest, repo: rest, path: "", children: [], staged: 0, unstaged: 0, changed: 0 };
  const { repo, path } = splitKey(rest);
  if (kind === "d") return { id, kind: "dir", name: basename(path), repo, path, children: [], staged: 0, unstaged: 0, changed: 0 };
  return null;
}

/** Open the menu of what has the focus (Menu key, Shift F10). */
export function openKeyboardMenu() {
  const a = document.activeElement as HTMLElement | null;
  let el: Element | null = a && a !== document.body ? a : null;
  const tree = a?.closest?.("[data-files] .tree");
  if (tree) el = (files.cursor && document.getElementById(`fr-${files.cursor}`)) || tree;
  else if (app.view === "review" && (!a || a === document.body || a.closest?.("section[aria-label='Files'], section[aria-label='Diff']"))) {
    el = (app.rvs.focus === "diff" ? document.querySelector("[data-focus='true']") : document.querySelector("[data-sel='true']")) ?? el;
  } else if (!el && app.view === "code") el = document.querySelector(".tab[aria-selected='true']");
  if (!el) return;
  contextMenuAt(el);
}

/** Window level handler: text fields get Cut, Copy, Paste; nothing else shows the browser's menu. */
export function onGlobalContextMenu(e: MouseEvent) {
  if (e.defaultPrevented) return;
  if (isTextField(e.target)) {
    openAtEvent(e, textFieldMenu(e.target), "Edit");
    return;
  }
  e.preventDefault();
}

/** Wire the command bar and the Menu key to the builders above. */
export function installMenus() {
  app.contextItems = contextPaletteItems;
  app.onContextMenuKey = openKeyboardMenu;
}

