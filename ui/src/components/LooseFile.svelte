<script lang="ts">
  // "Little Arc": one file, outside every space, in a small window of its own. Cmd/Ctrl S saves.
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { createState, setLanguage } from "../lib/editor";
  import { languageOf } from "../lib/languages";

  let { path }: { path: string } = $props();

  let host: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined;
  let error = $state("");
  let saved = $state("");
  let dirty = $state(false);
  let phase = $state<"loading" | "ready" | "failed">("loading");
  const name = $derived(path.slice(path.lastIndexOf("/") + 1));

  async function save() {
    if (!view || !dirty) return;
    const text = view.state.doc.toString();
    try {
      await invoke("write_loose_file", { path, content: text });
      saved = text;
      dirty = false;
      error = "";
    } catch (e) {
      error = (e as { message?: string })?.message ?? String(e);
    }
  }

  onMount(() => {
    document.title = name;
    view = new EditorView({ parent: host! });
    void (async () => {
      try {
        const content = await invoke<string>("read_loose_file", { path });
        saved = content;
        view!.setState(
          createState({ path, repo: "", content, firstLine: 1, language: languageOf(path) } as never, (text) => {
            dirty = text !== saved;
          }),
        );
        void setLanguage(view!, languageOf(path), () => !!view);
        phase = "ready";
        view!.focus();
      } catch (e) {
        error = (e as { message?: string })?.message ?? String(e);
        phase = "failed";
      }
    })();
    return () => view?.destroy();
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="loose">
  <header>
    <b>{name}{dirty ? " •" : ""}</b>
    <span class="path" title={path}>{path}</span>
    <button class="btn p" disabled={!dirty} onclick={save}>Save</button>
  </header>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  <div class="host" class:hidden={phase === "failed"} bind:this={host}></div>
</div>

<style>
  .loose {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    color: var(--faint);
  }
  .err {
    margin: 0;
    padding: 8px 12px;
    color: var(--del, #e5534b);
    font-size: 12.5px;
  }
  .host {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .host :global(.cm-editor) {
    flex: 1;
    min-width: 0;
  }
  .hidden {
    display: none;
  }
</style>
