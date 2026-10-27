<script lang="ts">
  // Terminals of the space, under the current view. T or Ctrl ` toggles, Ctrl Shift ` adds one.
  import { app } from "../lib/app.svelte";
  import { colorOfRepo } from "../lib/colors";
  import Kbd from "./Kbd.svelte";
  import XtermView from "./XtermView.svelte";

  const MIN = 120;
  const list = $derived(app.spaceTerms);
  const current = $derived(app.activeTerm);

  function drag(e: PointerEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const start = app.termHeight;
    const max = Math.max(MIN, window.innerHeight * 0.7);
    const move = (ev: PointerEvent) => {
      app.termHeight = Math.round(Math.max(MIN, Math.min(max, start + (startY - ev.clientY))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function nudge(e: KeyboardEvent) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    e.stopPropagation();
    app.termHeight = Math.max(MIN, app.termHeight + (e.key === "ArrowUp" ? 24 : -24));
  }
</script>

<section class="tp" style:height="{app.termHeight}px" aria-label="Terminal">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="handle" role="separator" aria-orientation="horizontal" aria-label="Resize the terminal" tabindex="0" onpointerdown={drag} onkeydown={nudge}></div>
  <header>
    <div class="tabs" role="tablist">
      {#each list as t (t.id)}
        <div class="tab" role="tab" tabindex="0" aria-selected={current?.id === t.id} class:exited={t.exited}
          onclick={() => {
            app.termActive[app.space.id] = t.id;
            app.termFocusSeq++;
          }}
          onkeydown={(e) => e.key === "Enter" && ((app.termActive[app.space.id] = t.id), app.termFocusSeq++)}>
          <span class="rdot" style:--rc={colorOfRepo(app.space, t.title.split(" ")[0])}></span>
          <span>{t.title}</span>
          <button class="x" aria-label="Close terminal {t.title}" onclick={(e) => { e.stopPropagation(); void app.closeTerminal(t.id); }}>×</button>
        </div>
      {/each}
    </div>
    <div class="acts">
      {#if app.space.repos.length > 1}
        {#each app.space.repos as r (r.name)}
          <button class="btn" title="New terminal in {r.name}" onclick={() => app.newTerminal(r.name)}>+ {r.name}</button>
        {/each}
      {:else}
        <button class="btn" title="New terminal" onclick={() => app.newTerminal()}>+ terminal</button>
      {/if}
      <button class="x" aria-label="Hide the terminal" title="Hide (T)" onclick={() => app.toggleTerminal()}>⌄</button>
    </div>
  </header>
  <div class="body">
    {#each app.terms as t (t.id)}
      <XtermView id={t.id} active={t.spaceId === app.space.id && current?.id === t.id} />
    {/each}
    {#if !list.length}
      <div class="empty">No terminal in this space. <button class="btn" onclick={() => app.newTerminal()}>Open one <Kbd k="Ctrl Shift `" /></button></div>
    {/if}
  </div>
</section>

<style>
  .tp {
    flex: none;
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-radius: 16px;
    overflow: hidden;
  }
  .handle {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 6px;
    cursor: row-resize;
    z-index: 2;
  }
  .handle:hover,
  .handle:focus-visible {
    background: var(--line);
    outline: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 0;
  }
  .tabs {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    flex: 1;
    min-width: 0;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    padding: 0 10px;
    border-radius: 8px;
    font-size: 12px;
    color: var(--faint);
    white-space: nowrap;
    cursor: default;
  }
  .tab:hover,
  .tab[aria-selected="true"] {
    background: var(--hover);
    color: var(--fg);
  }
  .tab.exited span:not(.rdot) {
    text-decoration: line-through;
  }
  .rdot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--rc);
  }
  .acts {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .acts .btn {
    height: 26px;
    font-size: 12px;
  }
  .x {
    color: var(--faint);
    padding: 0 4px;
    font-size: 14px;
  }
  .body {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .empty {
    padding: 24px;
    color: var(--muted);
    font-size: 13px;
    display: flex;
    gap: 10px;
    align-items: center;
  }
</style>
