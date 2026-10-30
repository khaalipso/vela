<script lang="ts">
  import { selectAll } from "@codemirror/commands";
    import { isHtml, isMarkdown } from "../lib/app.svelte";
    import { inlineAssets } from "../lib/htmlpreview";
  import { colorOfRepo } from "../lib/colors";
  // The Markdown renderer is loaded with the first preview.
  const markdownView = () => import("./MarkdownView.svelte");
  import { EditorView } from "@codemirror/view";
  import { onDestroy, onMount, tick } from "svelte";
  import { oldestToDrop, tabLabels } from "../lib/tabs";
  import { app } from "../lib/app.svelte";
  import type { FileContent } from "../lib/backend";
  import { menu, openAtEvent, isKeyboardEvent } from "../lib/contextmenu.svelte";
  import { mount, unmount } from "svelte";
  import {
    changeMarks,
    createState,
    firstLineFacet,
    focusLine,
    replaceContent,
    setChangeSpans,
    setChanges,
    changeSpans,
    toggleFind,
    setHunks,
    setLanguage,
    setPeek,
    type HunkSpec,
  } from "../lib/editor";
  import ChangePeek from "./ChangePeek.svelte";
  import { fileKey } from "../lib/format";
  import { editorMenu, tabMenu } from "../lib/menus";
  import { readClipboard, writeClipboard } from "../lib/ops.svelte";

  /** "main" has the tabs; "split" shows the file chosen for the second pane. */
  let { pane = "main" }: { pane?: "main" | "split" } = $props();

  let host: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined;
  /** Space and file the editor currently shows, and the load in flight. */
  let shown = "";
  let loadSeq = 0;
  let loading = false;
  let handledFocus = 0;
  let handledFind = app.findSeq;
  /** Text of the open file, for the Markdown preview. */
  let text = $state("");
  let previewFind = $state(0);

  const tabs = $derived(app.cui.tabs);
  const current = $derived(pane === "main" ? app.cui.file : (app.cui.split ?? ""));
  const active = $derived(app.activePane === pane || (pane === "main" && !app.cui.split));
  const rev = $derived(app.contentRev[app.space.id] ?? 0);
  /** A Markdown file shows rendered unless V asked for its source. */
  const preview = $derived(!!current && isMarkdown(current) && !app.mdSource[`${app.space.id}:${current}`]);
  /** An HTML file shows as the page it is once asked to (the bar's button, or Preview in a menu). */
  const rendered = $derived(!!current && isHtml(current) && !!app.htmlRendered[`${app.space.id}:${current}`]);
  let page = $state("");
  // The page with its local CSS and JS inlined; read again when the file changes.
  $effect(() => {
    if (!rendered) return;
    const sid = app.space.id;
    const [repo, path] = split(current);
    void rev;
    const src = text;
    let stale = false;
    void inlineAssets(src, path, (p) =>
      app.backend.readFile(sid, repo, p).then((f) => f.content, () => null),
    ).then((h) => {
      if (!stale) page = h;
    });
    return () => (stale = true);
  });
  const labels = $derived(tabLabels(tabs.map((t) => t.key)));
  // The tabs wrap onto a second line; if two lines are not enough, the oldest tab goes.
  let tabsEl: HTMLDivElement | undefined = $state();
  let tabsW = $state(0);
  $effect(() => {
    if (!tabsEl) return;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => (tabsW = tabsEl?.clientWidth ?? 0));
    ro.observe(tabsEl);
    return () => ro.disconnect();
  });
  $effect(() => {
    void tabsW;
    void labels;
    const list = tabs;
    const cur = current;
    void tick().then(() => {
      if (!tabsEl || list.length < 2 || list !== app.cui.tabs) return;
      const one = tabsEl.querySelector<HTMLElement>(".tab")?.offsetHeight ?? 30;
      if (tabsEl.scrollHeight <= one * 2 + 4 + 16 + 2) return;
      const old = oldestToDrop(list, cur);
      if (old) app.closeTab(old);
    });
  });
  const tint = (key: string) => colorOfRepo(app.space, key.slice(0, key.indexOf("/")));

  function split(key: string): [string, string] {
    const i = key.indexOf("/");
    return [key.slice(0, i), key.slice(i + 1)];
  }

  function specs(): HunkSpec[] {
    return app.pending
      .filter((p) => fileKey(p.hunk.repo, p.hunk.path) === current)
      .map((p) => ({ hunk: p.hunk, role: p.role, tool: p.tool, why: p.why }));
  }

  function pushHunks() {
    if (!view || loading) return;
    view.dispatch({
      effects: setHunks.of({
        specs: specs(),
        focusId: app.focused?.hunk.id ?? null,
        onFocus: (id) => (app.cui.hi = id),
      }),
    });
  }

  /** First line of the file shown (the mock shows snippets of big files). */
  let firstLine = 1;
  /** The change of yours opened under its lines, by hunk id. */
  let peekId = $state<string | null>(null);

  const mine = $derived(current ? app.myHunksOf(current) : []);
  const stagedN = $derived(mine.filter((h) => h.state === "staged").length);

  function pushChanges() {
    if (!view || loading) return;
    view.dispatch({
      effects: setChanges.of({
        marks: changeMarks(mine, firstLine, view.state.doc.lines),
        onClick: (id) => openPeek(peekId === id ? null : id),
      }),
    });
    view.dispatch({
      effects: setChangeSpans.of(changeSpans(mine, firstLine, view.state.doc.lines)),
    });
  }

  function openPeek(id: string | null) {
    peekId = id;
    pushPeek();
  }

  function pushPeek() {
    if (!view || loading) return;
    const i = mine.findIndex((h) => h.id === peekId);
    const h = mine[i];
    if (!h) {
      if (peekId) peekId = null;
      view.dispatch({ effects: setPeek.of(null) });
      return;
    }
    const last = Math.max(h.newStart, h.newStart + h.newLines - 1) - firstLine + 1;
    const total = mine.length;
    view.dispatch({
      effects: setPeek.of({
        line: last,
        key: `${h.id}:${h.state}:${i}:${total}`,
        mount: (el) => {
          const c = mount(ChangePeek, {
            target: el,
            props: {
              hunk: h,
              index: i,
              total,
              onstage: () => void app.stageMine(h.id, true),
              onunstage: () => void app.stageMine(h.id, false),
              onrevert: () => {
                peekId = null;
                void app.revertMine(h.id);
              },
              oncopy: () => {
                void writeClipboard(h.lines.filter((l) => l.kind === "del").map((l) => l.text).join("\n"));
                app.toast("Original lines copied");
              },
              onclose: () => openPeek(null),
              onmove: (d) => moveChange(d),
            },
          });
          return () => void unmount(c);
        },
      }),
    });
  }

  /** Go to the next (1) or previous (-1) change of yours from the cursor, and open it. */
  function moveChange(delta: 1 | -1) {
    if (!view || !mine.length) return app.toast("No change of yours in this file");
    const cur = peekId ? mine.findIndex((h) => h.id === peekId) : -1;
    let next: number;
    if (cur >= 0) next = (cur + delta + mine.length) % mine.length;
    else {
      const line = view.state.doc.lineAt(view.state.selection.main.head).number + firstLine - 1;
      next = delta === 1 ? mine.findIndex((h) => h.newStart > line) : mine.findLastIndex((h) => h.newStart < line);
      if (next < 0) next = delta === 1 ? 0 : mine.length - 1;
    }
    const h = mine[next];
    openPeek(h.id);
    const ln = Math.min(view.state.doc.lines, Math.max(1, h.newStart - firstLine + 1));
    view.dispatch({ selection: { anchor: view.state.doc.line(ln).from }, effects: EditorView.scrollIntoView(view.state.doc.line(ln).from, { y: "center" }) });
  }

  function maybeFocus() {
    const r = app.focusRequest;
    if (!view || loading || !r || r.seq === handledFocus || r.file !== shown.split("\u0000")[1]) return;
    handledFocus = r.seq;
    focusLine(view, r.line);
  }

  async function load(sid: string, key: string) {
    if (!view) return;
    const seq = ++loadSeq;
    const [repo, path] = split(key);
    loading = true;
    let f: FileContent;
    try {
      f = await app.backend.readFile(sid, repo, path);
    } catch (e) {
      loading = false;
      return;
    }
    if (seq !== loadSeq || !view) return;
    const id = `${sid}\u0000${key}`;
    if (shown !== id) {
      view.setState(
        createState(f, (content) => {
          text = content;
          void app.writeFile(repo, path, content);
        }),
      );
      shown = id;
      void setLanguage(view, f.language, () => shown === id && !!view);
    } else {
      replaceContent(view, f.content);
    }
    text = f.content;
    firstLine = f.firstLine;
    loading = false;
    pushChanges();
    pushPeek();
    pushHunks();
    maybeFocus();
  }

  onMount(() => {
    view = new EditorView({ parent: host! });
  });

  /** Right click (or the Menu key) in the editor: Cut, Copy, Paste, Select all, then file actions. */
  function editorContext(e: MouseEvent) {
    const v = view;
    if (!v || !current) return;
    const keyboard = isKeyboardEvent(e);
    const sel = v.state.selection.main;
    let pos = sel.head;
    if (!keyboard) {
      pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? sel.head;
      // A right click outside the selection puts the cursor there, like most editors.
      if (pos < sel.from || pos > sel.to) v.dispatch({ selection: { anchor: pos } });
    }
    const main = v.state.selection.main;
    const first = v.state.facet(firstLineFacet);
    const info = {
      key: current,
      line: v.state.doc.lineAt(pos).number + first - 1,
      lastLine: v.state.doc.lines + first - 1,
      selection: !main.empty,
      copy: () => {
        void writeClipboard(v.state.sliceDoc(main.from, main.to));
        v.focus();
      },
      cut: () => {
        void writeClipboard(v.state.sliceDoc(main.from, main.to));
        v.dispatch(v.state.replaceSelection(""));
        v.focus();
      },
      paste: () => {
        void readClipboard().then((t) => {
          if (t === null) app.toast("Press Ctrl V to paste here");
          else v.dispatch(v.state.replaceSelection(t));
          v.focus();
        });
      },
      selectAll: () => {
        selectAll(v);
        v.focus();
      },
    };
    if (keyboard) {
      e.preventDefault();
      const c = v.coordsAtPos(pos);
      menu.open(editorMenu(info), { x: c?.left ?? e.clientX, y: (c?.bottom ?? e.clientY) + 2, keyboard: true, label: "Editor" });
    } else openAtEvent(e, editorMenu(info), "Editor");
  }
  onDestroy(() => {
    loadSeq++;
    view?.destroy();
    view = undefined;
  });

  // Open or reload the file when the space, the file or the content on the backend changes.
  $effect(() => {
    const sid = app.space.id;
    const key = current;
    rev;
    if (key && view) void load(sid, key);
  });

  // Proposals or focus changed: redraw the widgets.
  $effect(() => {
    specs();
    app.focused;
    pushHunks();
    void tick().then(() => host?.querySelector<HTMLElement>("[data-focus='true']")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  });

  $effect(() => {
    app.focusRequest;
    maybeFocus();
  });

  // Your changes moved (stage, revert, refresh): redraw the bars and the open peek.
  $effect(() => {
    mine;
    pushChanges();
    pushPeek();
  });

  // A new file closes the peek.
  $effect(() => {
    current;
    peekId = null;
  });

  let handledMove = app.changeMove.seq;
  $effect(() => {
    const m = app.changeMove;
    if (m.seq === handledMove) return;
    handledMove = m.seq;
    if (!active) return;
    moveChange(m.delta);
  });

  // Ctrl F from outside the editor: the find bar of the preview, or of the editor.
  $effect(() => {
    const seq = app.findSeq;
    if (seq === handledFind) return;
    handledFind = seq;
    if (!current || !active) return;
    if (preview) previewFind++;
    else if (view) toggleFind(view);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="pane" class:split={pane === "split"} onfocusin={() => (app.activePane = pane)} onpointerdown={() => (app.activePane = pane)}>
{#if pane === "split"}
  <div class="tabs">
    <div class="tab" style:--rc={current ? tint(current) : "var(--faint)"} aria-selected="true">
      {#if current}<span class="rdot"></span><span class="rp">{current.slice(0, current.indexOf("/"))}</span><span class="mono">{current.slice(current.indexOf("/") + 1)}</span>{:else}<span class="mono">Split view</span>{/if}
      <button class="close" aria-label="Close split" title="Close split (Ctrl \\)" onclick={() => app.closeSplit()}>×</button>
    </div>
  </div>
{:else}
<div class="tabs" role="tablist" bind:this={tabsEl}>
  {#each tabs as t (t.key)}
    {@const k = t.key}
    <div class="tab" class:preview={!t.pinned} style:--rc={tint(k)} role="tab" title={k} aria-selected={k === current} tabindex="0" onclick={() => (app.cui.file = k)} ondblclick={() => app.openFile(app.active, k, true)} oncontextmenu={(e) => openAtEvent(e, tabMenu(k), "Tab")} onkeydown={(e) => e.key === "Enter" && (app.cui.file = k)}>
      <span class="mono">{labels.get(k) ?? k}</span>
      <button class="close" aria-label="Close tab" onclick={(e) => { e.stopPropagation(); app.closeTab(k); }}>×</button>
    </div>
  {/each}
  {#if tabs.length && !app.cui.split}
    <button class="splitbtn" title="Split view (Ctrl \\)" aria-label="Split view" onclick={() => app.toggleSplit()}>⫴</button>
  {/if}
</div>
{/if}
{#if !current}
  <div class="nofile">
    <b>No file open</b>
    <span>Pick a file in the tree on the left, or press <kbd>Ctrl P</kbd> to find one.</span>
    {#if pane === "main" && !app.filesOpen}<button class="btn" onclick={() => app.dispatch({ type: "toggle-files" })}>Show files <kbd>B</kbd></button>{/if}
  </div>
{/if}
{#if current && mine.length && !preview}
  <div class="chgbar" aria-label="Your changes in this file">
    <span class="cdot unst"></span><span>{mine.length - stagedN} not staged</span>
    <span class="cdot stg"></span><span>{stagedN} staged</span>
    <button class="ic" title="Previous change (Ctrl Alt ↑)" aria-label="Previous change" onclick={() => moveChange(-1)}>↑</button>
    <button class="ic" title="Next change (Ctrl Alt ↓)" aria-label="Next change" onclick={() => moveChange(1)}>↓</button>
    <span class="sp"></span>
    {#if mine.length - stagedN}
      <button class="lnk" onclick={() => { const [r, p] = split(current); void app.backend.stageFile(app.space.id, r, p).then(() => app.refresh()); }}>Stage file</button>
    {/if}
    {#if stagedN}
      <button class="lnk" onclick={() => { const [r, p] = split(current); void app.backend.unstageFile(app.space.id, r, p).then(() => app.refresh()); }}>Unstage file</button>
    {/if}
    <button class="lnk danger" onclick={() => app.revertFile(current)} title="Back to the last commit; you can undo it from the notification">Revert file</button>
  </div>
{/if}
{#if current && isMarkdown(current)}
  <div class="mdbar">
    <span>{preview ? "Preview" : "Source"}</span>
    <button class="btn" onclick={() => app.dispatch({ type: "toggle-preview" })}>{preview ? "Show source" : "Show preview"} <kbd>V</kbd></button>
  </div>
{/if}
{#if current && isHtml(current)}
  <div class="mdbar">
    <span>{rendered ? "Preview" : "Source"}</span>
    <button class="btn" onclick={() => app.dispatch({ type: "toggle-preview" })}>{rendered ? "Show source" : "Show preview"} <kbd>V</kbd></button>
  </div>
{/if}
{#if rendered}
  <iframe class="page" title="Preview of {current}" sandbox="allow-scripts allow-forms allow-popups" srcdoc={page}></iframe>
{/if}
{#if preview}
  <div class="mdscroll">
  {#await markdownView() then { default: MarkdownView }}
  <MarkdownView
    {text}
    findSeq={previewFind}
    onopenurl={(u) => void app.backend.openUrl(u)}
    onopenfile={(p) => {
      const [repo, path] = split(current);
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      const parts: string[] = [];
      for (const seg of (dir + p).split("/")) {
        if (seg === "..") parts.pop();
        else if (seg && seg !== ".") parts.push(seg);
      }
      app.openFile(app.active, `${repo}/${parts.join("/")}`, true);
    }}
  />
  {/await}
  </div>
{/if}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="code"
  class:hidden={!current || preview || rendered}
  bind:this={host}
  oncontextmenu={editorContext}
  onkeydowncapture={(e) => {
    if (e.key === "Escape" && peekId) {
      e.stopPropagation();
      e.preventDefault();
      openPeek(null);
    }
  }}
></div>
</div>

<style>
  .pane {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* The pane does not scroll (the editor has its own scroller): the preview needs one. */
  .page {
    flex: 1 1 0;
    min-height: 0;
    width: 100%;
    border: 0;
    background: #fff;
  }
  .mdscroll {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    --find-top: 0px;
  }
  .pane.split {
    border-left: 1px solid var(--line);
  }
  .splitbtn {
    margin-left: auto;
    color: var(--faint);
    padding: 0 10px;
    border-radius: 6px;
  }
  .splitbtn:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .nofile {
    padding: 64px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    color: var(--muted);
  }
  .nofile b {
    color: var(--fg);
    font-size: 16px;
  }
  .nofile kbd {
    font-family: var(--code);
    font-size: 11px;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--hover);
    color: var(--fg);
  }
  .hidden {
    display: none;
  }
  .tabs {
    flex: none;
    display: flex;
    gap: 4px;
    padding: 8px;
    position: sticky;
    top: 0;
    background: var(--panel);
    z-index: 2;
    flex-wrap: wrap;
  }
  .tab .mono {
    max-width: 28ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 12px;
    border-radius: 8px;
    font-size: 12px;
    color: var(--faint);
    white-space: nowrap;
    transition: background-color 200ms var(--ease);
  }
  .tab.preview .mono {
    font-style: italic;
  }
  .close {
    color: var(--faint);
    padding: 0 2px;
  }
  .tab {
    background: color-mix(in srgb, var(--rc) 16%, transparent);
  }
  .tab:hover {
    background: color-mix(in srgb, var(--rc) 26%, var(--hover));
  }
  .tab[aria-selected="true"] {
    background: color-mix(in srgb, var(--rc) 36%, var(--hover));
    color: var(--fg);
    box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--rc) 75%, transparent);
  }
  .rdot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--rc);
    flex: none;
  }
  .rp {
    color: color-mix(in srgb, var(--rc) 70%, var(--faint));
  }
  .chgbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 16px 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .cdot {
    width: 4px;
    height: 12px;
    border-radius: 2px;
    margin-left: 4px;
  }
  .cdot.unst {
    background: var(--warn);
  }
  .cdot.stg {
    background: var(--add);
  }
  .chgbar .sp {
    flex: 1;
  }
  .chgbar .ic {
    color: var(--faint);
    padding: 0 6px;
    border-radius: 6px;
  }
  .chgbar .ic:hover,
  .chgbar .lnk:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .chgbar .lnk {
    color: var(--faint);
    padding: 2px 8px;
    border-radius: 6px;
  }
  .chgbar .lnk.danger:hover {
    color: var(--del);
    background: var(--del-bg);
  }
  .mdbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 16px 6px;
    font-size: 12px;
    color: var(--faint);
  }
  .mdbar kbd {
    font-family: var(--code);
    font-size: 11px;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--hover);
    color: var(--fg);
  }
  .code {
    flex: 1 1 0;
    min-height: 0;
    padding: 8px 0 0;
    overflow: hidden;
  }
  .code :global(.cm-editor) {
    height: 100%;
  }
</style>
