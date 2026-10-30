<script lang="ts">
  import { colorOfRepo } from "../lib/colors";
  import type { TNode } from "../lib/filetree";
  import { onMount, tick, untrack } from "svelte";
  import { app } from "../lib/app.svelte";
  import { files } from "../lib/files.svelte";
  import { fileKey } from "../lib/format";
  import {
    CHIPS,
    ROW_HEIGHT,
    allContainerIds,
    buildTree,
    defaultExpanded,
    dirMark,
    EDIT_ID,
    fileId,
    flatten,
    highlightRuns,
    marks,
    navigate,
    revealIds,
    scrollToRow,
    windowRange,
    withNewRow,
    type Chip,
    type FileEntry,
    type NavCmd,
    type Row,
  } from "../lib/filetree";
  import { menu, openAtEvent } from "../lib/contextmenu.svelte";
  import { treeMenu } from "../lib/menus";
  import { basename, dirname, ops } from "../lib/ops.svelte";
  import Kbd from "./Kbd.svelte";

  let root: HTMLElement | undefined = $state();
  let scroller: HTMLDivElement | undefined = $state();
  let input: HTMLInputElement | undefined = $state();
  let tree: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let viewport = $state(0);

  const sid = $derived(app.space.id);
  const prep = $derived(files.prepare(sid));
  const full = $derived(prep ? buildTree(prep.repos) : []);
  const view = $derived(files.filtering ? files.view : null);
  const roots = $derived(view ? view.roots : full);
  const expanded = $derived(view ? ("all" as const) : files.expandedOf(sid));
  const baseRows = $derived(flatten(roots, expanded));
  const edit = $derived(files.edit);
  // A new file or folder is named in a row of its own, first inside its folder.
  const rows = $derived(edit && edit.mode !== "rename" && !view ? withNewRow(baseRows, edit.repo, edit.dir) : baseRows);
  const win = $derived(windowRange(rows.length, scrollTop, viewport || 480));
  const shown = $derived(rows.slice(win.start, win.end));
  const openKey = $derived(app.cui.file);
  const cursorIndex = $derived(rows.findIndex((r) => r.node.id === files.cursor));

  function split(key: string): { repo: string; path: string } | null {
    const i = key.indexOf("/");
    return i < 0 ? null : { repo: key.slice(0, i), path: key.slice(i + 1) };
  }

  const measure = () => (viewport = scroller?.clientHeight ?? 0);
  $effect(() => {
    scroller;
    measure();
  });

  onMount(() => {
    files.loadWidth();
    files.show(true, sid);
    return () => files.show(false);
  });

  // The space changed: load its files.
  $effect(() => {
    files.show(true, sid);
  });

  // Default expansion, once per space.
  $effect(() => {
    if (!full.length) return;
    untrack(() => files.seed(sid, () => defaultExpanded(full, split(openKey))));
  });

  // The open file is always revealed and under the cursor.
  let revealed = "";
  $effect(() => {
    const key = openKey;
    const t = full;
    if (!t.length || files.filtering) return;
    untrack(() => {
      const id = `${sid}:${key}`;
      if (revealed === id) return;
      revealed = id;
      reveal();
    });
  });

  function reveal() {
    const f = split(app.cui.file);
    if (!f) return;
    files.query = "";
    files.chip = "all";
    files.view = null;
    files.expand(sid, revealIds(full, f.repo, f.path));
    files.cursor = fileId(f.repo, f.path);
  }

  // Recompute the filter when the query, the chip or the listing changes.
  $effect(() => {
    files.query;
    files.chip;
    files.data[sid];
    untrack(() => files.refilter(sid));
  });

  // The best match gets the cursor.
  $effect(() => {
    const v = view;
    if (!v) return;
    untrack(() => {
      files.cursor = v.top ?? rows.find((r) => r.node.kind === "file")?.node.id ?? null;
    });
  });

  // Keep the cursor row in view.
  $effect(() => {
    const i = cursorIndex;
    if (i < 0 || !scroller) return;
    const top = scrollToRow(i, scroller.scrollTop, scroller.clientHeight || 480);
    if (top !== scroller.scrollTop) {
      scroller.scrollTop = top;
      scrollTop = top;
    }
  });

  function open(e: FileEntry, o: { pin?: boolean; focusEditor?: boolean } = {}) {
    app.openFile(app.active, fileKey(e.repo, e.path), !!o.pin);
    if (o.focusEditor) {
      void tick().then(tick).then(() => document.querySelector<HTMLElement>(".cm-content")?.focus());
    }
  }

  function nav(cmd: NavCmd) {
    const r = navigate(rows, files.cursor, view ? allContainerIds(roots) : files.expandedOf(sid), cmd);
    files.cursor = r.cursor;
    if (!view) files.setExpanded(sid, r.expanded);
    if (r.open) open(r.open, { focusEditor: r.focusEditor });
    else if (r.focusEditor) return;
  }

  async function toggleStage() {
    const row = rows[cursorIndex];
    const e = row?.node.file;
    if (!e) return;
    try {
      // Fully staged: unstage. Anything else (unstaged change, or a clean row): stage.
      if (e.staged && !e.unstaged) await app.backend.unstageFile(sid, e.repo, e.path);
      else await app.backend.stageFile(sid, e.repo, e.path);
      await files.load(sid);
    } catch (err) {
      app.toast(err instanceof Error ? err.message : String(err));
    }
  }

  function cursorNode() {
    const r = rows[cursorIndex];
    return r && r.node.id !== EDIT_ID ? r.node : null;
  }
  // Drag and drop: a file or folder onto a folder (or the repo) of the same repo moves it there.
  let dragged = $state<TNode | null>(null);
  let dropId = $state("");
  const targetDir = (n: TNode) => (n.kind === "repo" ? "" : n.kind === "dir" ? n.path : dirname(n.path));
  function dragStart(e: DragEvent, n: TNode) {
    dragged = n;
    e.dataTransfer?.setData("text/plain", n.path);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
  }
  function dragOver(e: DragEvent, n: TNode) {
    if (!dragged || dragged.repo !== n.repo || n.id === EDIT_ID) return;
    const dir = targetDir(n);
    if (dir === dirname(dragged.path) || (dragged.kind === "dir" && (dir === dragged.path || dir.startsWith(`${dragged.path}/`)))) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
    dropId = n.kind === "file" ? "" : n.id;
  }
  function drop(e: DragEvent, n: TNode) {
    const d = dragged;
    dragged = null;
    dropId = "";
    if (!d || d.repo !== n.repo) return;
    e.preventDefault();
    const dir = targetDir(n);
    if (e.ctrlKey) {
      ops.copyEntry(d.repo, d.path, d.kind === "dir");
      void ops.paste(n.repo, dir);
    } else void ops.moveTo(d.repo, d.path, d.kind === "dir", dir);
  }

  function renameCursor() {
    const n = cursorNode();
    if (n && n.kind !== "repo") ops.startRename(n.repo, n.path, n.kind === "dir");
  }
  function deleteCursor() {
    const n = cursorNode();
    if (n && n.kind !== "repo") void ops.askDelete(n.repo, n.path, n.kind === "dir");
  }

  function rowMenu(e: MouseEvent, r: Row) {
    if (r.node.id === EDIT_ID) return;
    files.cursor = r.node.id;
    tree?.focus({ preventScroll: true });
    openAtEvent(e, treeMenu(r.node), r.node.name || "Files");
  }

  /** The ⋯ button of a row opens the same menu under itself. */
  function moreMenu(e: MouseEvent, r: Row) {
    e.stopPropagation();
    files.cursor = r.node.id;
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu.open(treeMenu(r.node), { x: b.left, y: b.bottom + 2, invoker: tree ?? null, label: r.node.name });
  }

  function editKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void ops.commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      ops.cancelEdit();
    }
  }

  function setChip(c: Chip) {
    files.chip = c;
  }

  function focusFilter(char = "") {
    if (char) files.query += char;
    input?.focus();
    const n = input?.value.length ?? 0;
    input?.setSelectionRange(n, n);
  }

  function stop(e: Event) {
    e.preventDefault();
    e.stopPropagation();
  }

  function onRootKey(e: KeyboardEvent) {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const c = CHIPS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (c) {
        stop(e);
        setChip(c.id);
      }
    }
  }

  const KEYS: Record<string, NavCmd> = {
    j: "down",
    ArrowDown: "down",
    k: "up",
    ArrowUp: "up",
    h: "left",
    ArrowLeft: "left",
    l: "right",
    ArrowRight: "right",
    Enter: "enter",
    Home: "first",
    End: "last",
    H: "collapse-all",
  };

  function onTreeKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && "xcv".includes(e.key.toLowerCase()) && e.key.length === 1) {
      const n = cursorNode();
      if (!n) return;
      const x = e.key.toLowerCase();
      e.preventDefault();
      e.stopPropagation();
      if (x === "v") void ops.paste(n.repo, n.kind === "repo" ? "" : n.kind === "dir" ? n.path : dirname(n.path));
      else if (n.kind !== "repo") (x === "x" ? ops.cutEntry : ops.copyEntry)(n.repo, n.path, n.kind === "dir");
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const cmd = KEYS[k];
    if (cmd) return stop(e), nav(cmd);
    if (k === " ") return stop(e), void toggleStage();
    if (k === ".") return stop(e), reveal();
    if (k === "F2") return stop(e), renameCursor();
    if (k === "Delete") return stop(e), deleteCursor();
    if (k === "/") return stop(e), focusFilter();
    if (k === "Escape") {
      stop(e);
      if (files.filtering) files.clearFilter();
      else (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    if (/^[a-zA-Z_-]$/.test(k)) return stop(e), focusFilter(k);
  }

  function onInputKey(e: KeyboardEvent) {
    const k = e.key;
    if (k === "Enter") {
      stop(e);
      const row = rows.find((r) => r.node.id === (view?.top ?? files.cursor));
      if (row?.node.file) open(row.node.file, { focusEditor: true });
    } else if (k === "ArrowDown") {
      stop(e);
      tree?.focus();
    } else if (k === "Escape") {
      stop(e);
      if (files.query) files.query = "";
      else tree?.focus();
    }
  }

  function clickRow(r: Row) {
    files.cursor = r.node.id;
    if (r.node.kind === "file") open(r.node.file!);
    else if (!view) files.toggle(sid, r.node.id);
  }

  function dblRow(r: Row) {
    if (r.node.kind === "file") open(r.node.file!, { pin: true });
  }

  // -- resize ---------------------------------------------------------------

  const maxWidth = () => Math.max(200, (root?.parentElement?.clientWidth ?? 1000) - 380);
  function drag(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const left = root!.getBoundingClientRect().left;
    const move = (m: PointerEvent) => files.setWidth(m.clientX - left, maxWidth());
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      files.saveWidth();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }
  function resizeKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    stop(e);
    files.setWidth(files.width + (e.key === "ArrowLeft" ? -16 : 16), maxWidth());
    files.saveWidth();
  }
</script>

<svelte:window onresize={measure} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside class="files" aria-label="Files" bind:this={root} style:width="{files.width}px" data-files onkeydown={onRootKey}>
  <header>
    <h3>Files</h3>
    <button class="x" aria-label="Close files" onclick={() => app.dispatch({ type: "toggle-files" })}><Kbd k="B" /></button>
  </header>
  <div class="search">
    <input
      bind:this={input}
      data-files-filter
      aria-label="Filter files by name"
      placeholder="Filter by name"
      autocomplete="off"
      spellcheck="false"
      bind:value={files.query}
      onkeydown={onInputKey}
    />
    {#if !files.query}<Kbd k="/" />{/if}
  </div>
  <div class="chips" role="group" aria-label="Show">
    {#each CHIPS as c (c.id)}
      <button class="chip" aria-pressed={files.chip === c.id} title="Alt {c.key}" onclick={() => setChip(c.id)}>{c.label}</button>
    {/each}
    {#if view}
      <span class="count" aria-live="polite">{view.count} {view.count === 1 ? "match" : "matches"}</span>
    {/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="tree"
    role="tree"
    tabindex="0"
    aria-label="Files of the space"
    aria-activedescendant={files.cursor ? `fr-${files.cursor}` : undefined}
    bind:this={tree}
    onkeydown={onTreeKey}
  >
    <div class="scroll" bind:this={scroller} onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}>
      {#if !prep}
        <div class="empty">Loading files</div>
      {:else if !rows.length}
        <div class="empty">{files.filtering ? "No file matches" : "No files"}</div>
      {/if}
      <div class="spacer" style:height="{win.height}px">
        <div class="win" style:transform="translateY({win.offset}px)">
          {#each shown as r (r.node.id)}
            {@const n = r.node}
            {@const dm = n.kind === "file" ? null : dirMark(n)}
            <div
              class="row {n.kind}"
              id="fr-{n.id}"
              role="treeitem"
              tabindex="-1"
              aria-selected={files.cursor === n.id}
              aria-level={r.depth + 1}
              aria-expanded={n.kind === "file" ? undefined : view ? true : files.expandedOf(sid).has(n.id)}
              class:cur={files.cursor === n.id}
              class:open={n.kind === "file" && openKey === fileKey(n.repo, n.path)}
              style:height="{ROW_HEIGHT}px"
              style:padding-left="{8 + r.depth * 14}px"
              style:--rc={n.kind === "repo" ? colorOfRepo(app.space, n.repo) : undefined}
              draggable={n.kind !== "repo" && n.id !== EDIT_ID}
              ondragstart={(e) => dragStart(e, n)}
              ondragover={(e) => dragOver(e, n)}
              ondragleave={() => (dropId === n.id ? (dropId = "") : null)}
              ondrop={(e) => drop(e, n)}
              ondragend={() => ((dragged = null), (dropId = ""))}
              class:drop={dropId === n.id}
              onclick={() => clickRow(r)}
              ondblclick={() => dblRow(r)}
              oncontextmenu={(e) => rowMenu(e, r)}
              onkeydown={() => {}}
            >
              {#if n.id === EDIT_ID}
                <span class="chev"></span>
                {@render editor()}
              {:else if edit?.mode === "rename" && edit.repo === n.repo && edit.path === n.path && n.kind !== "repo"}
                <span class="chev"></span>
                {@render editor()}
              {:else if n.kind === "file"}
                <span class="chev"></span>
                <span class="nm">
                  {#each highlightRuns(n.name, view?.positions.get(n.id), n.path.length - n.name.length) as h, i (i)}<span class:hit={h.hit}>{h.text}</span>{/each}
                </span>
                {#each marks(n.file!) as m, i (i)}<span class="st {m.tone}">{m.letter}</span>{/each}
              {:else}
                <span class="chev" class:down={view ? true : files.expandedOf(sid).has(n.id)}>
                  <svg width="10" height="10" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M96 48l80 80-80 80" /></svg>
                </span>
                <span class="nm">
                  {#each highlightRuns(n.name, view?.dirPositions.get(n.id), 0) as h, i (i)}<span class:hit={h.hit}>{h.text}</span>{/each}
                </span>
                {#if n.kind === "repo" && n.info}
                  <span class="br mono">{n.info.branch}</span>
                  {#if n.info.ahead}<span class="ab">↑{n.info.ahead}</span>{/if}
                  {#if n.info.behind}<span class="ab">↓{n.info.behind}</span>{/if}
                {/if}
                {#if dm}<span class="dm {dm.tone}" title="{dm.count} changed">{dm.count}</span>{/if}
              {/if}
              {#if n.id !== EDIT_ID}
                <button class="more" tabindex="-1" aria-label="Actions for {n.name || n.repo}" title="Actions" onclick={(e) => moreMenu(e, r)}><svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><circle cx="56" cy="128" r="20" /><circle cx="128" cy="128" r="20" /><circle cx="200" cy="128" r="20" /></svg></button>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
  {#if prep?.src.some((r) => r.truncated)}<div class="note">Very large repo: the list is cut at 200,000 files.</div>{/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="grip"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize the files drawer"
    aria-valuenow={files.width}
    tabindex="0"
    onpointerdown={drag}
    onkeydown={resizeKey}
  ></div>
</aside>

{#snippet editor()}
  <span class="ed">
    <input
      class="edit"
      data-tree-edit
      aria-label={edit?.mode === "rename" ? "New name" : edit?.mode === "dir" ? "Name of the new folder" : "Name of the new file"}
      aria-invalid={edit?.error ? true : undefined}
      placeholder={edit?.mode === "dir" ? "folder name" : "file name"}
      autocomplete="off"
      spellcheck="false"
      value={edit?.value ?? ""}
      oninput={(e) => {
        if (!files.edit) return;
        files.edit.value = e.currentTarget.value;
        files.edit.error = "";
      }}
      onkeydown={editKey}
      onblur={() => files.edit && (files.edit.value.trim() ? void ops.commitEdit() : ops.cancelEdit())}
      onclick={(e) => e.stopPropagation()}
    />
    {#if edit?.error}<span class="edit-err" role="alert">{edit.error}</span>{/if}
  </span>
{/snippet}

<style>
  .files {
    flex: none;
    min-width: 200px;
    position: relative;
    background: var(--panel);
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    animation: enter 320ms var(--ease);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px 4px 16px;
  }
  h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
  }
  .search {
    margin: 4px 12px 0;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 8px;
    background: var(--raised);
    border-radius: 8px;
  }
  .search:focus-within {
    outline: 2px solid var(--space);
  }
  .search input {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    outline: none;
    font: inherit;
    font-size: 13px;
    color: var(--fg);
  }
  .search input::placeholder {
    color: var(--faint);
  }
  .chips {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 12px;
  }
  .chip {
    height: 24px;
    padding: 0 10px;
    border-radius: 9999px;
    font-size: 12px;
    color: var(--muted);
    background: var(--raised);
    transition: background-color 200ms var(--ease);
  }
  .chip:hover {
    background: var(--hover);
  }
  .chip[aria-pressed="true"] {
    background: var(--space);
    color: var(--on-accent);
    font-weight: 600;
  }
  .count {
    margin-left: auto;
    font-size: 12px;
    color: var(--faint);
  }
  .tree {
    flex: 1;
    min-height: 0;
    display: flex;
    outline: none;
  }
  .tree:focus-visible {
    outline: none;
  }
  .scroll {
    flex: 1;
    overflow: auto;
    padding: 0 6px 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-right: 8px;
    border-radius: 8px;
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.drop {
    background: color-mix(in srgb, var(--space) 24%, transparent);
    outline: 1px dashed var(--space);
  }
  .row.cur {
    background: var(--hover);
  }
  .tree:focus-within .row.cur {
    outline: 2px solid var(--space);
    outline-offset: -2px;
  }
  .row.open .nm {
    color: var(--space);
    font-weight: 600;
  }
  .row.repo .nm {
    font-weight: 600;
    color: color-mix(in srgb, var(--rc) 75%, var(--fg));
  }
  .row.repo {
    background: color-mix(in srgb, var(--rc) 8%, transparent);
    box-shadow: inset 2px 0 0 color-mix(in srgb, var(--rc) 80%, transparent);
  }
  .chev {
    width: 12px;
    flex: none;
    display: inline-flex;
    justify-content: center;
    color: var(--faint);
    transition: transform 200ms var(--ease);
  }
  .chev.down {
    transform: rotate(90deg);
  }
  .nm {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row.file .nm {
    flex: 1;
  }
  .hit {
    color: var(--space);
    font-weight: 700;
  }
  .br {
    color: var(--faint);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ab {
    color: var(--faint);
    font-size: 11px;
  }
  .st,
  .dm {
    font-family: var(--code);
    font-size: 11px;
    font-weight: 600;
    margin-left: auto;
  }
  .st + .st {
    margin-left: 0;
  }
  .st.staged,
  .dm.staged {
    color: var(--add);
  }
  .st.unstaged,
  .dm.unstaged {
    color: var(--warn);
  }
  .st.conflict {
    color: var(--del);
  }
  .row.dir .dm,
  .row.repo .dm {
    margin-left: auto;
  }
  .more {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    display: none;
    place-items: center;
    color: var(--muted);
    font-weight: 700;
    line-height: 1;
  }
  .row:hover .more,
  .row.cur .more,
  .more:focus-visible {
    display: grid;
  }
  .more:hover {
    background: var(--line);
    color: var(--fg);
  }
  .ed {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .edit {
    width: 100%;
    height: 22px;
    padding: 0 6px;
    border: 0;
    border-radius: 6px;
    background: var(--raised);
    color: var(--fg);
    font: inherit;
    font-size: 13px;
    outline: 2px solid var(--space);
  }
  .edit[aria-invalid="true"] {
    outline-color: var(--del);
  }
  .edit-err {
    position: absolute;
    z-index: 2;
    margin-top: 24px;
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--del);
    color: var(--on-accent);
    font-size: 11px;
  }
  .note {
    padding: 6px 16px;
    font-size: 12px;
    color: var(--warn);
  }
  .grip {
    position: absolute;
    top: 8px;
    bottom: 8px;
    right: -5px;
    width: 8px;
    cursor: col-resize;
    border-radius: 4px;
    z-index: 3;
  }
  .grip:hover,
  .grip:active {
    background: var(--space);
    opacity: 0.5;
  }
  .x {
    height: 24px;
    padding: 0 4px;
    border-radius: 6px;
  }
  @media (max-width: 760px) {
    .files {
      width: auto !important;
      max-height: 45vh;
    }
    .grip {
      display: none;
    }
  }
</style>
