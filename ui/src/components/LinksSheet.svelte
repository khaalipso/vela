<script lang="ts">
  import { onMount, tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { openAtEvent } from "../lib/contextmenu.svelte";
  import { linkMenu } from "../lib/menus";
  import { KIND_LABEL, KIND_SINGULAR, SOURCE_LABEL, linkSub, removable } from "../lib/links";
  import Kbd from "./Kbd.svelte";
  import LinkMark from "./LinkMark.svelte";

  let input: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  const items = $derived(app.orderedLinks);
  const sel = $derived(Math.min(app.linksUi.i, Math.max(0, items.length - 1)));
  const preview = $derived(app.linkPreview);
  const typed = $derived(app.linksUi.q.trim() !== "");

  onMount(() => input?.focus());

  $effect(() => {
    sel;
    void tick().then(() => list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={(e) => e.target === e.currentTarget && app.closeOverlay()}>
  <div class="sheet" role="dialog" aria-label="Links">
    <div class="pin">
      <svg width="18" height="18" viewBox="0 0 256 256" fill="none" stroke="var(--faint)" stroke-width="20" stroke-linecap="round" aria-hidden="true"
        ><path d="M104 152a40 40 0 0 0 56 0l40-40a40 40 0 0 0-56-56l-12 12M152 104a40 40 0 0 0-56 0l-40 40a40 40 0 0 0 56 56l12-12" /></svg
      >
      <label for="links-in" class="sr">Add a link</label>
      <input
        id="links-in"
        autocomplete="off"
        spellcheck="false"
        placeholder="Paste a URL to link it to {app.space.name}"
        bind:this={input}
        bind:value={app.linksUi.q}
      />
    </div>
    {#if typed}
      <div class="preview" class:bad={!preview}>
        {#if preview}
          <LinkMark link={preview} />
          <span class="t">{preview.title}</span>
          <span class="k">{KIND_SINGULAR[preview.kind]}{preview.key && preview.key !== preview.title ? ` · ${preview.key}` : ""}</span>
          <span class="go">Enter to add <Kbd k="Enter" /></span>
        {:else}
          <span class="t">Not a full http or https URL yet</span>
        {/if}
      </div>
    {/if}
    <div class="plist" role="listbox" bind:this={list}>
      {#if !items.length}
        <div class="empty none">No links yet. Paste an issue, a doc or a staging URL above, or just paste anywhere.</div>
      {/if}
      {#each items as l, i (l.id)}
        {#if i === 0 || items[i - 1].kind !== l.kind}<div class="psec">{KIND_LABEL[l.kind]}</div>{/if}
        <button
          class="pit"
          role="option"
          aria-selected={i === sel}
          onclick={() => {
            app.linksUi.i = i;
            void app.openLink(l.id);
          }}
          oncontextmenu={(e) => {
            app.linksUi.i = i;
            openAtEvent(e, linkMenu(l), l.title);
          }}
        >
          <LinkMark link={l} />
          <span class="t">{l.title}{#if linkSub(l)}<small>{linkSub(l)}</small>{/if}</span>
          <span class="src">{SOURCE_LABEL[l.source]}</span>
        </button>
      {/each}
    </div>
    <div class="pfoot">
      <span><Kbd k="J" /><Kbd k="K" /> move</span>
      <span><Kbd k="Enter" /> open</span>
      {#if items[sel] && removable(items[sel])}<span><Kbd k="Backspace" /> remove</span>{/if}
      <span><Kbd k="Esc" /> field, then close</span>
    </div>
  </div>
</div>

<style>
  .pin {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
  }
  .pin input {
    flex: 1;
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
  .preview {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 10px 6px;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--raised);
    font-size: 13px;
  }
  .preview.bad {
    color: var(--faint);
  }
  .preview .t {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .preview .k {
    color: var(--faint);
    font-size: 12px;
  }
  .preview .go {
    margin-left: auto;
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: var(--faint);
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
    padding: 8px 10px;
    border-radius: 10px;
    text-align: left;
  }
  .pit[aria-selected="true"] {
    background: var(--hover);
  }
  .t {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t small {
    color: var(--faint);
    margin-left: 8px;
    font-size: 12px;
  }
  .src {
    flex: none;
    font-size: 11px;
    color: var(--faint);
  }
</style>
