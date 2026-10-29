<script lang="ts">
  // The terminals of the space in one panel: under the view (Ctrl Down, T or Ctrl `) or above it
  // (Ctrl Up). Both can be open: they shrink before the view between them gets too small.
  // Hiding a panel keeps its shells running; Ctrl Shift ` adds one at the bottom.
  import { app, type TermDock } from "../lib/app.svelte";
  import { colorOfRepo } from "../lib/colors";
  import Kbd from "./Kbd.svelte";
  import XtermView from "./XtermView.svelte";

  let { dock = "bottom" }: { dock?: TermDock } = $props();
  const top = $derived(dock === "top");

  const MIN = 96;
  const list = $derived(app.termsOf(dock));
  const current = $derived(app.activeTermOf(dock));
  const open = $derived(app.isTermOpen(dock) && !app.elsewhere);
  const height = $derived(top ? app.termTopHeight : app.termHeight);
  let el: HTMLElement | undefined = $state();

  function setHeight(h: number) {
    if (top) app.termTopHeight = h;
    else app.termHeight = h;
  }
  /** As tall as the view between the panels allows: it keeps its own minimum height. */
  function maxHeight(): number {
    const view = el?.parentElement?.querySelector<HTMLElement>(":scope > .body");
    if (!el || !view) return Math.max(MIN, window.innerHeight * 0.6);
    const viewMin = parseFloat(getComputedStyle(view).minHeight) || 0;
    return Math.max(MIN, el.offsetHeight + view.offsetHeight - viewMin);
  }
  function drag(e: PointerEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const start = el?.offsetHeight ?? height;
    const max = maxHeight();
    const move = (ev: PointerEvent) => {
      const dy = top ? ev.clientY - startY : startY - ev.clientY;
      setHeight(Math.round(Math.max(MIN, Math.min(max, start + dy))));
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
    const grow = top ? e.key === "ArrowDown" : e.key === "ArrowUp";
    setHeight(Math.max(MIN, Math.min(maxHeight(), (el?.offsetHeight ?? height) + (grow ? 24 : -24))));
  }
</script>

<section
  class="tp"
  class:top
  class:hidden={!open}
  bind:this={el}
  style:flex-basis="{height}px"
  aria-label={top ? "Terminal on top" : "Terminal"}
  aria-hidden={!open}
>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="handle" role="separator" aria-orientation="horizontal" aria-label="Resize the terminal" tabindex="0" onpointerdown={drag} onkeydown={nudge}></div>
  <header>
    <div class="tabs" role="tablist">
      {#each list as t (t.id)}
        <div class="tab" role="tab" tabindex="0" aria-selected={current?.id === t.id} class:exited={t.exited}
          onclick={() => app.focusTerm(dock, t.id)}
          onkeydown={(e) => e.key === "Enter" && app.focusTerm(dock, t.id)}>
          <span class="rdot" style:--rc={colorOfRepo(app.space, t.title.split(" ")[0])}></span>
          <span>{t.title}</span>
          <button class="x" aria-label="Close terminal {t.title}" onclick={(e) => { e.stopPropagation(); void app.closeTerminal(t.id); }}>×</button>
        </div>
      {/each}
    </div>
    <div class="acts">
      {#if app.space.repos.length > 1}
        {#each app.space.repos as r (r.name)}
          <button class="btn" title="New terminal in {r.name}" onclick={() => app.newTerminal(r.name, 100, 24, dock)}>+ {r.name}</button>
        {/each}
      {:else}
        <button class="btn" title="New terminal" onclick={() => app.newTerminal(null, 100, 24, dock)}>+ terminal</button>
      {/if}
      <button class="x" aria-label="Hide the terminal" title={top ? "Hide (Ctrl ↑)" : "Hide (T)"} onclick={() => app.toggleTerminal(dock)}>{top ? "⌃" : "⌄"}</button>
    </div>
  </header>
  <div class="body">
    {#each app.terms.filter((t) => t.dock === dock) as t (t.id)}
      <XtermView id={t.id} {dock} active={t.spaceId === app.space.id && current?.id === t.id} />
    {/each}
    {#if !list.length}
      <div class="empty">No terminal in this space. <button class="btn" onclick={() => app.newTerminal(null, 100, 24, dock)}>Open one <Kbd k={top ? "Ctrl ↑" : "Ctrl Shift `"} /></button></div>
    {/if}
  </div>
</section>

<style>
  .tp.hidden {
    display: none;
  }
  /* Shrinks with the window, before the view between the panels gets under its minimum. */
  .tp {
    flex: 0 1 auto;
    min-height: 96px;
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
  .tp.top .handle {
    top: auto;
    bottom: 0;
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
