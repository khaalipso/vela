<script lang="ts">
  import { onMount, tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import Kbd from "./Kbd.svelte";

  let input: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  const items = $derived(app.paletteItems);
  const sel = $derived(Math.min(app.pal.i, Math.max(0, items.length - 1)));

  onMount(() => input?.focus());

  $effect(() => {
    sel;
    void tick().then(() => list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={(e) => e.target === e.currentTarget && app.closeOverlay()}>
  <div class="sheet" role="dialog" aria-label="Command bar">
    <div class="pin">
      <svg width="18" height="18" viewBox="0 0 256 256" fill="none" stroke="var(--faint)" stroke-width="20" stroke-linecap="round" aria-hidden="true"
        ><circle cx="112" cy="112" r="72" /><path d="M163 163l53 53" /></svg
      >
      <label for="pal-in" class="sr">Search</label>
      <input
        id="pal-in"
        autocomplete="off"
        placeholder="Jump to a space, a file, or run an action"
        bind:this={input}
        bind:value={app.pal.q}
        oninput={() => (app.pal.i = 0)}
      />
    </div>
    <div class="plist" role="listbox" bind:this={list}>
      {#if !items.length}
        <div class="empty none">No match. Try a file name, a space, or “commit”.</div>
      {/if}
      {#each items as x, i (x.sec + x.title + (x.sub ?? ""))}
        {#if i === 0 || items[i - 1].sec !== x.sec}<div class="psec">{x.sec}</div>{/if}
        <button class="pit" role="option" aria-selected={i === sel} onclick={() => app.runPalette(x)}>
          <span class="dot" style:--c={x.dot ?? "var(--line)"}></span>
          <span class="t">{x.title}{#if x.sub}<small>{x.sub}</small>{/if}</span>
          {#if x.key}<Kbd k={x.key} />{/if}
        </button>
      {/each}
    </div>
    <div class="pfoot">
      <span><Kbd k="↑" /><Kbd k="↓" /> move</span>
      <span><Kbd k="Enter" /> run</span>
      <span><Kbd k="Esc" /> close</span>
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
</style>
