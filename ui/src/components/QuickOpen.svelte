<script lang="ts">
  import { onMount, tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { files } from "../lib/files.svelte";
  import { fileKey } from "../lib/format";
  import { highlightRuns, ROW_HEIGHT } from "../lib/filetree";
  import Kbd from "./Kbd.svelte";

  let input: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  let q = $state("");
  let sel = $state(0);

  const sid = $derived(app.space.id);
  const results = $derived((files.data[sid], files.quick(sid, q, app.cui.recent)));
  const at = $derived(Math.min(sel, Math.max(0, results.length - 1)));

  onMount(() => {
    files.show(true, sid);
    input?.focus();
    return () => files.show(false);
  });

  $effect(() => {
    at;
    void tick().then(() => list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
  });

  function go(i: number) {
    const h = results[i];
    if (!h) return;
    app.openFile(app.active, fileKey(h.entry.repo, h.entry.path), false);
    void tick().then(tick).then(() => document.querySelector<HTMLElement>(".cm-content")?.focus());
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") sel = Math.min(results.length - 1, at + 1);
    else if (e.key === "ArrowUp") sel = Math.max(0, at - 1);
    else if (e.key === "Enter") go(at);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function parts(path: string) {
    const i = path.lastIndexOf("/") + 1;
    return { dir: path.slice(0, i), base: path.slice(i), cut: i };
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={(e) => e.target === e.currentTarget && app.closeOverlay()}>
  <div class="sheet" role="dialog" aria-label="Go to file">
    <div class="pin">
      <label for="qo-in" class="sr">Go to file</label>
      <input
        id="qo-in"
        autocomplete="off"
        spellcheck="false"
        placeholder="Go to file in all repos of this space"
        bind:this={input}
        bind:value={q}
        oninput={() => (sel = 0)}
        onkeydown={onKey}
      />
    </div>
    <div class="plist" role="listbox" bind:this={list}>
      {#if !results.length}
        <div class="empty none">{q ? "No file matches." : "Nothing opened yet. Type a file name."}</div>
      {/if}
      {#each results as h, i (h.entry.repo + "/" + h.entry.path)}
        {@const p = parts(h.entry.path)}
        <button class="pit" role="option" aria-selected={i === at} style:min-height="{ROW_HEIGHT + 8}px" onclick={() => go(i)}>
          <span class="tag">{h.entry.repo}</span>
          <span class="t">
            <span class="dir">{#each highlightRuns(p.dir, h.positions, 0) as r, k (k)}<span class:hit={r.hit}>{r.text}</span>{/each}</span><b>{#each highlightRuns(p.base, h.positions, p.cut) as r, k (k)}<span class:hit={r.hit}>{r.text}</span>{/each}</b>
          </span>
        </button>
      {/each}
    </div>
    <div class="pfoot">
      <span><Kbd k="↑" /><Kbd k="↓" /> move</span>
      <span><Kbd k="Enter" /> open</span>
      <span><Kbd k="Esc" /> close</span>
    </div>
  </div>
</div>

<style>
  .pin {
    padding: 14px 16px;
  }
  .pin input {
    width: 100%;
    background: none;
    border: 0;
    outline: none;
    font: inherit;
    font-size: 16px;
    color: var(--fg);
  }
  .pin input::placeholder {
    color: var(--faint);
  }
  .sr {
    position: absolute;
    left: -9999px;
  }
  .plist {
    max-height: 52vh;
    overflow: auto;
    padding: 6px;
  }
  .none {
    padding: 16px;
  }
  .pit {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 10px;
    border-radius: 10px;
    text-align: left;
  }
  .pit[aria-selected="true"] {
    background: var(--hover);
  }
  .tag {
    font-size: 11px;
    color: var(--faint);
    padding: 0 6px;
    border-radius: 4px;
    background: var(--raised);
    flex: none;
  }
  .t {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dir {
    color: var(--faint);
    font-size: 12px;
  }
  b {
    font-weight: 500;
  }
  .hit {
    color: var(--space);
    font-weight: 700;
  }
</style>
