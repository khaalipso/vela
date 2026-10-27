// What the menu items do: file operations on the tree and the tabs, space operations on the
// rail, with their confirmation sheets. Menus (menus.ts) only build lists of these calls, so the
// same operations are reachable from the command bar.

import { tick } from "svelte";
import { app } from "./app.svelte";
import { buildTree, dirId, fileId, repoId, revealIds, type FileEntry } from "./filetree";
import { files } from "./files.svelte";
import { fileKey, plural } from "./format";
import { hunkPatch } from "./patch";
import { closeOthers, closeToRight, currentAfter, renameKeys, setPinned } from "./tabs";
import type { FileChange, Hunk, Link, Space } from "./types";

// -- clipboard ------------------------------------------------------------------

/** The clipboard API, or a hidden textarea and `execCommand` where it is not allowed. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* denied: try the fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch {
    return false;
  }
}

/** Text from the clipboard, null when the browser does not allow reading it. */
export async function readClipboard(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch {
    /* denied */
  }
  return null;
}

// -- paths ----------------------------------------------------------------------

export function splitKey(key: string): { repo: string; path: string } {
  const i = key.indexOf("/");
  return i < 0 ? { repo: key, path: "" } : { repo: key.slice(0, i), path: key.slice(i + 1) };
}

export const dirname = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
export const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** Why a name typed in the tree cannot be used, null when it can. */
export function nameProblem(name: string, nested: boolean): string | null {
  const n = name.trim();
  if (!n) return "Type a name";
  if (!nested && n.includes("/")) return "A name cannot hold a slash";
  if (n.startsWith("/")) return "Use a path inside the repo";
  if (n.split("/").some((s) => s === "" || s === "." || s === "..")) return "Not a valid path";
  if (n.split("/")[0] === ".git") return ".git is off limits";
  if (/[\u0000-\u001f]/.test(n)) return "Control characters are not allowed";
  return null;
}

/** Inline edit in the tree: a new file or folder under `dir`, or a rename of `path`. */
export interface TreeEdit {
  mode: "rename" | "file" | "dir";
  repo: string;
  /** Folder the new entry goes in (new modes), or the folder of the renamed entry. */
  dir: string;
  /** The entry being renamed. */
  path: string;
  isDir: boolean;
  value: string;
  error: string;
}

export const SPACE_COLORS: { name: string; hex: string }[] = [
  { name: "Amber", hex: "#E8A14A" },
  { name: "Sky", hex: "#7DB8F5" },
  { name: "Violet", hex: "#C9A0F0" },
  { name: "Green", hex: "#4ADE80" },
  { name: "Pink", hex: "#F0A3C0" },
  { name: "Mint", hex: "#9BD0C8" },
];

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Ops {
  // -- helpers --------------------------------------------------------------

  private get sid(): string {
    return app.space.id;
  }

  statusOf(repo: string, path: string): FileChange | undefined {
    return app.sd.status.find((c) => c.repo === repo && c.path === path);
  }

  /** Entries (files with their status) of one repo of the space, from the tree listing. */
  entriesIn(repo: string, dir = ""): FileEntry[] {
    const prep = files.prepare(this.sid);
    const prefix = dir ? `${dir}/` : "";
    return (prep?.entries ?? []).filter((e) => e.repo === repo && e.path.startsWith(prefix));
  }

  private async reload() {
    await app.refresh(this.sid);
    await files.load(this.sid);
  }

  async copy(text: string, what: string) {
    app.toast((await writeClipboard(text)) ? `Copied ${what}` : "Could not reach the clipboard");
  }

  // -- copy and reveal ----------------------------------------------------------

  async copyAbsolute(repo: string, path: string) {
    try {
      await this.copy(await app.backend.absolutePath(this.sid, repo, path), path ? "the path" : "the worktree path");
    } catch (e) {
      app.fail(e);
    }
  }
  copyRelative(path: string) {
    return this.copy(path, "the relative path");
  }
  copyRepoPath(repo: string, path: string) {
    return this.copy(`${repo}:${path}`, "repo:path");
  }
  copyBranch(space: Space) {
    return this.copy(space.branch, `${space.branch}`);
  }
  copyUrl(link: Link) {
    return this.copy(link.url, "the URL");
  }
  copyPatch(h: Hunk) {
    return this.copy(hunkPatch(h), "the hunk as a patch");
  }
  /** `repo/path:line` for a line of the open file. */
  copyLineLink(key: string, line: number) {
    return this.copy(`${key}:${line}`, `${key}:${line}`);
  }

  async reveal(repo: string, path: string) {
    try {
      await app.backend.revealPath(this.sid, repo, path);
    } catch (e) {
      app.fail(e);
    }
  }

  async terminal(repo: string, path: string) {
    try {
      await app.backend.openTerminal(this.sid, repo, path);
    } catch (e) {
      const m = msg(e);
      app.toast(/no terminal/i.test(m) ? "No terminal found. Set $TERMINAL or install one" : m);
    }
  }

  // -- staging ----------------------------------------------------------------

  async stage(repo: string, path: string) {
    try {
      await app.backend.stageFile(this.sid, repo, path);
    } catch (e) {
      app.fail(e);
    }
    await this.reload();
  }
  async unstage(repo: string, path: string) {
    try {
      await app.backend.unstageFile(this.sid, repo, path);
    } catch (e) {
      app.fail(e);
    }
    await this.reload();
  }

  /** Stage (or unstage) every file below a folder; an empty `dir` is the whole repo. */
  async stageInside(repo: string, dir: string, stage: boolean) {
    const list = this.entriesIn(repo, dir).filter((e) => (stage ? e.unstaged : e.staged));
    if (!list.length) return app.toast(stage ? "Nothing to stage here" : "Nothing staged here");
    try {
      for (const e of list) {
        if (stage) await app.backend.stageFile(this.sid, repo, e.path);
        else await app.backend.unstageFile(this.sid, repo, e.path);
      }
    } catch (e) {
      app.fail(e);
    }
    await this.reload();
    app.toast(`${stage ? "Staged" : "Unstaged"} ${plural(list.length, "file", "files")}`);
  }

  // -- open ---------------------------------------------------------------------

  open(repo: string, path: string, pin = false) {
    app.openFile(app.active, fileKey(repo, path), pin);
  }

  // -- discard, delete --------------------------------------------------------------

  /** Ask before throwing away the unstaged changes of a file. Untracked files need a tick box. */
  askDiscard(repo: string, path: string) {
    const c = this.statusOf(repo, path);
    if (!c?.unstaged) return app.toast("No unstaged changes to discard");
    const untracked = c.unstaged === "untracked";
    const mine = app.sd.hunks.filter((h) => h.repo === repo && h.path === path && h.origin.type === "you" && h.state === "pending");
    const items = untracked
      ? [path]
      : mine.length
        ? mine.map((h) => {
            const add = h.lines.filter((l) => l.kind === "add").length;
            const del = h.lines.filter((l) => l.kind === "del").length;
            return `${path}:${h.newStart}  +${add} −${del}`;
          })
        : [`${path}: ${c.unstaged === "deleted" ? "the deletion" : "your unstaged changes"}`];
    app.sheet = {
      kind: "confirm",
      title: untracked ? `Delete ${basename(path)}?` : `Discard changes to ${basename(path)}?`,
      body: untracked
        ? "This file is new and git does not track it. Discarding deletes it, and git cannot bring it back."
        : c.staged
          ? "These unstaged changes are lost. What you staged stays."
          : "These changes are lost. The file goes back to the last commit.",
      items,
      confirmLabel: untracked ? "Delete the file" : "Discard changes",
      danger: true,
      ack: untracked ? "I understand this file will be gone for good" : undefined,
      run: async () => {
        try {
          await app.backend.discardFile(this.sid, repo, path);
          app.toast(untracked ? `Deleted ${basename(path)}` : `Discarded changes to ${basename(path)}`);
        } catch (e) {
          app.fail(e);
        }
        await this.reload();
      },
    };
    app.overlay = "sheet";
  }

  /** Delete to the system trash; where there is none, ask and delete for good. */
  async askDelete(repo: string, path: string, isDir: boolean) {
    try {
      const how = await app.backend.deletePath(this.sid, repo, path, false);
      this.afterDelete(repo, path, how === "trashed" ? `Moved ${basename(path)} to the trash` : `Deleted ${basename(path)}`);
    } catch (e) {
      if ((e as { kind?: string }).kind !== "no_trash") return app.fail(e);
      const n = isDir ? this.entriesIn(repo, path).length : 1;
      app.sheet = {
        kind: "confirm",
        title: `Delete ${basename(path)} for good?`,
        body: "There is no trash on this machine. The delete cannot be undone.",
        items: isDir ? [`${path}/  (${plural(n, "file", "files")})`] : [path],
        confirmLabel: "Delete for good",
        danger: true,
        run: async () => {
          try {
            await app.backend.deletePath(this.sid, repo, path, true);
            this.afterDelete(repo, path, `Deleted ${basename(path)}`);
          } catch (err) {
            app.fail(err);
          }
        },
      };
      app.overlay = "sheet";
    }
  }

  private afterDelete(repo: string, path: string, toast: string) {
    const key = fileKey(repo, path);
    const u = app.cui;
    const keep = u.tabs.filter((t) => t.key !== key && !t.key.startsWith(`${key}/`));
    if (keep.length !== u.tabs.length) {
      u.tabs = keep;
      u.file = currentAfter(keep, u.file, "");
    }
    app.toast(toast);
    void this.reload();
  }

  // -- inline edits in the tree --------------------------------------------------

  startNew(mode: "file" | "dir", repo: string, dir: string) {
    app.filesOpen = true;
    files.query = "";
    files.chip = "all";
    files.view = null;
    files.expand(this.sid, dir ? [dirId(repo, dir), repoId(repo)] : [repoId(repo)]);
    files.edit = { mode, repo, dir, path: "", isDir: false, value: "", error: "" };
    this.focusEdit();
  }

  startRename(repo: string, path: string, isDir: boolean) {
    app.filesOpen = true;
    files.edit = { mode: "rename", repo, dir: dirname(path), path, isDir, value: basename(path), error: "" };
    this.focusEdit();
  }

  private focusEdit() {
    void tick()
      .then(tick)
      .then(() => {
        const el = document.querySelector<HTMLInputElement>("[data-tree-edit]");
        el?.focus();
        el?.select();
      });
  }

  cancelEdit() {
    files.edit = null;
    void tick().then(() => document.querySelector<HTMLElement>(".files .tree")?.focus());
  }

  async commitEdit() {
    const ed = files.edit;
    if (!ed) return;
    const name = ed.value.trim();
    if (!name || (ed.mode === "rename" && name === basename(ed.path))) return this.cancelEdit();
    const bad = nameProblem(name, ed.mode !== "rename");
    if (bad) {
      ed.error = bad;
      return;
    }
    const sid = this.sid;
    try {
      if (ed.mode === "rename") {
        const to = join(ed.dir, name);
        await app.backend.renamePath(sid, ed.repo, ed.path, to);
        this.afterRename(ed.repo, ed.path, to, ed.isDir);
      } else {
        const to = join(ed.dir, name);
        if (ed.mode === "file") {
          await app.backend.createFile(sid, ed.repo, to);
          files.edit = null;
          await this.reload();
          files.cursor = fileId(ed.repo, to);
          files.expand(sid, revealIds(buildTree(files.prepare(sid)?.repos ?? []), ed.repo, to));
          this.open(ed.repo, to, true);
          return;
        }
        await app.backend.createDir(sid, ed.repo, to);
        app.toast(`Created ${to}/. Git lists it once it holds a file`);
      }
    } catch (e) {
      ed.error = msg(e);
      return;
    }
    files.edit = null;
    await this.reload();
  }

  private afterRename(repo: string, from: string, to: string, isDir: boolean) {
    const a = fileKey(repo, from);
    const b = fileKey(repo, to);
    const u = app.cui;
    u.tabs = u.tabs.map((t) => ({ ...t, key: renameKeys([t.key], a, b)[0] }));
    u.file = renameKeys([u.file], a, b)[0];
    u.recent = renameKeys(u.recent, a, b);
    if (isDir) {
      const oldId = dirId(repo, from);
      const next = new Set<string>();
      for (const id of files.expandedOf(this.sid)) {
        next.add(id === oldId || id.startsWith(`${oldId}/`) ? dirId(repo, to) + id.slice(oldId.length) : id);
      }
      files.setExpanded(this.sid, next);
      files.cursor = dirId(repo, to);
    } else files.cursor = fileId(repo, to);
  }

  // -- tree view ------------------------------------------------------------------

  filterToFolder(repo: string, dir: string) {
    app.filesOpen = true;
    files.chip = "all";
    files.query = dir ? `${dir}/` : `${repo}/`;
    void tick().then(() => document.querySelector<HTMLElement>("[data-files-filter]")?.focus());
  }

  /** Collapse a folder and everything below it. */
  collapseInside(repo: string, dir: string) {
    const root = dirId(repo, dir);
    const next = new Set([...files.expandedOf(this.sid)].filter((id) => id !== root && !id.startsWith(`${root}/`)));
    files.setExpanded(this.sid, next);
    files.cursor = root;
  }

  /** Make the tree show a file: open the drawer, expand its folders, put the cursor on it. */
  async revealInTree(key: string) {
    const { repo, path } = splitKey(key);
    app.filesOpen = true;
    files.query = "";
    files.chip = "all";
    files.view = null;
    const prep = files.prepare(this.sid);
    if (prep) files.expand(this.sid, revealIds(buildTree(prep.repos), repo, path));
    files.cursor = fileId(repo, path);
    await tick();
    document.querySelector<HTMLElement>(".files .tree")?.focus();
  }

  /** Show the files of a repo: open the drawer on its node. */
  showRepoFiles(repo: string) {
    app.filesOpen = true;
    files.query = "";
    files.chip = "all";
    files.view = null;
    files.expand(this.sid, [repoId(repo)]);
    files.cursor = repoId(repo);
  }

  // -- tabs -----------------------------------------------------------------------

  closeTab(key: string) {
    app.closeTab(key);
  }
  closeOtherTabs(key: string) {
    const u = app.cui;
    u.tabs = closeOthers(u.tabs, key);
    u.file = key;
  }
  closeTabsToRight(key: string) {
    const u = app.cui;
    u.tabs = closeToRight(u.tabs, key);
    u.file = currentAfter(u.tabs, u.file, key);
  }
  closeAllTabs() {
    const u = app.cui;
    u.tabs = [];
    u.file = "";
  }
  togglePin(key: string) {
    const u = app.cui;
    const t = u.tabs.find((x) => x.key === key);
    if (t) u.tabs = setPinned(u.tabs, key, !t.pinned);
  }

  // -- editor ---------------------------------------------------------------------

  /** A small sheet that asks for a line number and puts the cursor there. */
  askGoToLine(key: string, max?: number) {
    app.sheet = {
      kind: "prompt",
      title: "Go to line",
      label: max ? `Line number (1 to ${max})` : "Line number",
      value: "",
      submitLabel: "Go",
      validate: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 ? null : "Type a line number"),
      run: (v) => app.gotoLine(key, Math.max(1, Math.min(max ?? Infinity, Number(v.trim())))),
    };
    app.overlay = "sheet";
  }

  // -- spaces ---------------------------------------------------------------------

  askRenameBranch() {
    const space = app.space;
    app.sheet = {
      kind: "prompt",
      title: "Rename the branch",
      label: "Branch",
      value: space.branch,
      submitLabel: "Rename",
      hint: `Renamed in ${space.repos.map((r) => r.name).join(", ")}, with the branches of its agents. The worktrees stay where they are; a pushed branch keeps its upstream until you push again.`,
      validate: (v) => {
        const b = v.trim();
        if (!b) return "Give the branch a name";
        if (/[\s~^:?*[\\]|\.\.|^[-/]|\/$|\.lock$/.test(b)) return "Git does not take this name";
        return null;
      },
      run: async (v) => {
        await app.renameBranch(v.trim());
      },
    };
    app.overlay = "sheet";
  }

  askRenameSpace(space: Space) {
    app.sheet = {
      kind: "prompt",
      title: "Rename space",
      label: "Name",
      value: space.name,
      submitLabel: "Rename",
      hint: "The branch and the worktrees keep their names.",
      validate: (v) => (v.trim() ? null : "Give the space a name"),
      run: async (v) => {
        try {
          await app.backend.renameSpace(space.id, v.trim());
          await this.spacesChanged();
        } catch (e) {
          app.fail(e);
        }
      },
    };
    app.overlay = "sheet";
  }

  async setColor(space: Space, hex: string) {
    try {
      await app.backend.setSpaceColor(space.id, hex);
      await this.spacesChanged();
    } catch (e) {
      app.fail(e);
    }
  }

  async archive(space: Space) {
    try {
      await app.backend.archiveSpace(space.id);
      await this.spacesChanged();
      app.toast(`Archived ${space.name}. Restore it from Archived in the rail`);
    } catch (e) {
      app.fail(e);
    }
  }

  async restore(space: Space) {
    try {
      await app.backend.unarchiveSpace(space.id);
      await this.spacesChanged();
      app.toast(`Restored ${space.name}`);
    } catch (e) {
      app.fail(e);
    }
  }

  askRemoveSpace(space: Space) {
    const dirty = app.data[space.id]?.status.length ?? 0;
    app.sheet = {
      kind: "confirm",
      title: `Remove ${space.name}?`,
      body:
        `The worktrees of this space are removed from disk. Branch ${space.branch} is deleted only when it is fully merged; ` +
        "a branch with unmerged commits stays in your repo." +
        (dirty ? ` ${plural(dirty, "file with uncommitted changes", "files with uncommitted changes")} will be lost.` : ""),
      items: space.repos.map((r) => `${r.name}  ${r.worktree}`),
      confirmLabel: "Remove space",
      danger: true,
      run: async () => {
        try {
          await app.backend.removeSpace(space.id);
          await this.spacesChanged();
          app.toast(`Removed ${space.name}`);
        } catch (e) {
          app.fail(e);
        }
      },
    };
    app.overlay = "sheet";
  }

  /** Reload the spaces after one was renamed, recolored, archived, restored or removed. */
  async spacesChanged() {
    const keep = app.spaces[app.active]?.id;
    const before = app.active;
    await app.syncSpaces();
    await app.loadArchived();
    const at = app.spaces.findIndex((s) => s.id === keep);
    app.active = at >= 0 ? at : Math.max(0, Math.min(before, app.spaces.length - 1));
  }

  async removeLink(link: Link) {
    try {
      await app.backend.removeLink(this.sid, link.id);
      const links = await app.backend.links(this.sid);
      app.data = { ...app.data, [this.sid]: { ...app.sd, links } };
      app.linksUi.i = Math.max(0, Math.min(app.linksUi.i, links.length - 1));
      app.toast(`Removed ${link.title}`);
    } catch (e) {
      app.fail(e);
    }
  }
}

export const ops = new Ops();
