<script lang="ts">
  // The page of the space (view 0): free Markdown for links, notes, commands. Kept by Vela next
  // to the space, never in a repo. Rendered by default; E (or a double click) writes in it.
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { Compartment, EditorState } from "@codemirror/state";
  import { EditorView, drawSelection, keymap } from "@codemirror/view";
  import { syntaxHighlighting } from "@codemirror/language";
  import { onDestroy, tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { openAtEvent } from "../lib/contextmenu.svelte";
  import { editorHighlight, editorTheme } from "../lib/editor";
  import { loadLanguage } from "../lib/languages";
  import { isHttpUrl } from "../lib/links";
  import { linkMenu } from "../lib/menus";
  import LinkMark from "./LinkMark.svelte";
  import MarkdownView from "./MarkdownView.svelte";

  const id = $derived(app.space.id);
  const page = $derived(app.pages[id]);
  const detected = $derived(app.detectedLinks);

  $effect(() => {
    void app.loadPage(id);
  });

  let host: HTMLDivElement | undefined = $state();
  /** Markdown highlighting loads lazily, into this slot. */
  const lang = new Compartment();
  let view: EditorView | null = null;
  /** The space the editor was opened on: switching space closes it. */
  let editorOf = "";

  /** A URL pasted over selected text makes a Markdown link of it. */
  const pasteLink = EditorView.domEventHandlers({
    paste(e, v) {
      const url = e.clipboardData?.getData("text/plain").trim() ?? "";
      const sel = v.state.selection.main;
      if (sel.empty || !isHttpUrl(url) || /\s/.test(url)) return false;
      const text = v.state.sliceDoc(sel.from, sel.to);
      e.preventDefault();
      v.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[${text}](${url})` } });
      return true;
    },
  });

  async function open() {
    await tick();
    if (!host || view) return;
    editorOf = id;
    const sid = id;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: app.pages[sid]?.text ?? "",
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          keymap.of([{ key: "Escape", run: () => (app.editPage(false), true) }, ...defaultKeymap, ...historyKeymap]),
          lang.of([]),
          syntaxHighlighting(editorHighlight),
          editorTheme,
          pasteLink,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) app.setPage(u.state.doc.toString(), sid);
          }),
        ],
      }),
    });
    const v = view;
    void loadLanguage("markdown").then((ext) => {
      if (view === v) v.dispatch({ effects: lang.reconfigure(ext) });
    });
    // The cursor at the end: you came to add something.
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    v.focus();
  }


  function close() {
    view?.destroy();
    view = null;
  }

  $effect(() => {
    const editing = app.pageEditing && !!page?.loaded;
    if (editing && !view) void open();
    else if ((!editing && view) || (view && editorOf !== id)) close();
  });
  onDestroy(() => {
    close();
    if (app.pageEditing) app.editPage(false);
  });

  function openFile(p: string) {
    const [first] = p.split("/");
    if (app.space.repos.some((r) => r.name === first)) app.openFile(app.active, p);
    else app.toast(`Write repo/path to open a file of the space: ${p}`);
  }
</script>

<div class="page">
  <header>
    <div class="head">
      <h2>Page</h2>
      <span class="sub">Notes and links of {app.space.name}. Kept by Vela, not in your repos.</span>
      <button class="btn" aria-pressed={app.pageEditing} onclick={() => app.editPage(!app.pageEditing)}>
        {app.pageEditing ? "Done" : "Write"} <kbd>{app.pageEditing ? "Esc" : "E"}</kbd>
      </button>
    </div>
    {#if detected.length}
      <div class="found" aria-label="Links found by Vela">
        <span class="lbl">Found</span>
        {#each detected as l (l.id)}
          <button
            class="lk"
            title={l.url || `${l.key ?? l.title}: no tracker URL configured`}
            onclick={() => app.openLink(l.id)}
            oncontextmenu={(e) => openAtEvent(e, linkMenu(l), l.title)}
          >
            <LinkMark link={l} /><span class="lt">{l.key && l.kind === "issue" ? l.key : l.title}</span>
          </button>
        {/each}
      </div>
    {/if}
  </header>

  {#if !page?.loaded}
    <div class="empty">Loading…</div>
  {:else if app.pageEditing}
    <div class="editor" bind:this={host}></div>
  {:else if page.text.trim()}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="rendered" ondblclick={() => app.editPage(true)}>
      <MarkdownView text={page.text} onopenurl={(u) => void app.backend.openUrl(u)} onopenfile={openFile} />
    </div>
  {:else}
    <button class="empty write" onclick={() => app.editPage(true)}>
      Nothing yet. Write links, notes, commands: anything this task needs. <kbd>E</kbd>
    </button>
  {/if}
</div>

<style>
  .page {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  header {
    max-width: 820px;
    width: 100%;
    margin: 0 auto;
    padding: 12px 32px 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .sub {
    color: var(--faint);
    font-size: 12px;
  }
  .btn {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 10px;
    border-radius: 7px;
    background: var(--hover);
    color: var(--fg);
    font-size: 13px;
  }
  .btn[aria-pressed="true"] {
    background: color-mix(in srgb, var(--space) 22%, transparent);
  }
  kbd {
    font-family: var(--code);
    font-size: 11px;
    color: var(--faint);
  }
  .found {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .lbl {
    font-size: 12px;
    color: var(--faint);
    margin-right: 2px;
  }
  .lk {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    max-width: 260px;
    padding: 0 8px 0 4px;
    border-radius: 7px;
    background: var(--panel);
    color: var(--muted);
    font-size: 12px;
  }
  .lk:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .lt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rendered {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .editor {
    flex: 1;
    min-height: 0;
    width: 100%;
    max-width: 820px;
    margin: 12px auto 0;
    padding: 0 20px 48px;
    box-sizing: border-box;
    overflow: auto;
  }
  .editor :global(.cm-editor) {
    min-height: 100%;
  }
  .empty {
    max-width: 820px;
    width: calc(100% - 64px);
    margin: 24px auto;
    color: var(--faint);
    font-size: 14px;
    text-align: left;
  }
  .empty.write {
    padding: 24px;
    border: 1px dashed var(--line);
    border-radius: 12px;
  }
  .empty.write:hover {
    color: var(--muted);
    border-color: var(--faint);
  }
  @media (max-width: 760px) {
    header {
      padding: 12px 16px 0;
    }
  }
</style>
