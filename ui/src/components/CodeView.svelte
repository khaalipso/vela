<script lang="ts">
  import { selectAll } from "@codemirror/commands";
  import { openSearchPanel } from "@codemirror/search";
  import { isMarkdown } from "../lib/app.svelte";
  import { colorOfRepo } from "../lib/colors";
  // The Markdown renderer is loaded with the first preview.
  const markdownView = () => import("./MarkdownView.svelte");
  import { EditorView } from "@codemirror/view";
  import { onDestroy, onMount, tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import type { FileContent } from "../lib/backend";
  import { menu, openAtEvent, isKeyboardEvent } from "../lib/contextmenu.svelte";
  import { createState, firstLineFacet, focusLine, replaceContent, setHunks, setLanguage, setMine, type HunkSpec } from "../lib/editor";
  import { fileKey } from "../lib/format";
  import { editorMenu, tabMenu } from "../lib/menus";
  import { readClipboard, writeClipboard } from "../lib/ops.svelte";

  let host: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined;
  /** Space and file the editor currently shows, and the load in flight. */
  let shown = "";
  let loadSeq = 0;
  let loading = false;
  let handledFocus = 0;
  let handledFind = 0;
  /** Text of the open file, for the Markdown preview. */
  let text = $state("");
  let previewFind = $state(0);

  const tabs = $derived(app.cui.tabs);
  const current = $derived(app.cui.file);
  const rev = $derived(app.contentRev[app.space.id] ?? 0);
  /** A Markdown file shows rendered unless V asked for its source. */
  const preview = $derived(!!current && isMarkdown(current) && !app.mdSource[`${app.space.id}:${current}`]);
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

  function pushMine(f: FileContent) {
    if (!view) return;
    const lines: number[] = [];
    for (const h of app.mine) {
      if (h.repo !== f.repo || h.path !== f.path) continue;
      for (let i = 0; i < h.newLines; i++) lines.push(h.newStart - f.firstLine + 1 + i);
    }
    view.dispatch({ effects: setMine.of(lines) });
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
    loading = false;
    pushMine(f);
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

  // Ctrl F from outside the editor: the find bar of the preview, or of the editor.
  $effect(() => {
    const seq = app.findSeq;
    if (seq === handledFind) return;
    handledFind = seq;
    if (!current) return;
    if (preview) previewFind++;
    else if (view) {
      view.focus();
      openSearchPanel(view);
    }
  });
</script>

<div class="tabs" role="tablist">
  {#each tabs as t (t.key)}
    {@const k = t.key}
    <div class="tab" class:preview={!t.pinned} style:--rc={tint(k)} role="tab" aria-selected={k === current} tabindex="0" onclick={() => (app.cui.file = k)} ondblclick={() => app.openFile(app.active, k, true)} oncontextmenu={(e) => openAtEvent(e, tabMenu(k), "Tab")} onkeydown={(e) => e.key === "Enter" && (app.cui.file = k)}>
      <span class="rdot"></span><span class="rp">{k.slice(0, k.indexOf("/"))}</span><span class="mono">{k.slice(k.indexOf("/") + 1)}</span>
      <button class="close" aria-label="Close tab" onclick={(e) => { e.stopPropagation(); app.closeTab(k); }}>×</button>
    </div>
  {/each}
</div>
{#if !current}
  <div class="nofile">
    <b>No file open</b>
    <span>Pick a file in the tree on the left, or press <kbd>Ctrl P</kbd> to find one.</span>
    {#if !app.filesOpen}<button class="btn" onclick={() => app.dispatch({ type: "toggle-files" })}>Show files <kbd>B</kbd></button>{/if}
  </div>
{/if}
{#if current && isMarkdown(current)}
  <div class="mdbar">
    <span>{preview ? "Preview" : "Source"}</span>
    <button class="btn" onclick={() => app.dispatch({ type: "toggle-preview" })}>{preview ? "Show source" : "Show preview"} <kbd>V</kbd></button>
  </div>
{/if}
{#if preview}
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
{/if}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="code" class:hidden={!current || preview} bind:this={host} oncontextmenu={editorContext}></div>

<style>
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
    display: flex;
    gap: 4px;
    padding: 8px;
    position: sticky;
    top: 0;
    background: var(--panel);
    z-index: 2;
    overflow-x: auto;
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
    background: color-mix(in srgb, var(--rc) 7%, transparent);
  }
  .tab:hover {
    background: color-mix(in srgb, var(--rc) 14%, var(--hover));
  }
  .tab[aria-selected="true"] {
    background: color-mix(in srgb, var(--rc) 20%, var(--hover));
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
    padding: 8px 0 0;
  }
</style>
