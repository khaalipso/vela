<script lang="ts">
  // The diffs of the Review, one file under the other (as on GitHub), in the order of the tree
  // on the left. The selected file is the one at the top of the screen: J K, a click in the tree
  // or Space scroll to the next one; scrolling selects the file you reach.
  import { tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { stackSel } from "../lib/reviewstack";
  import Kbd from "./Kbd.svelte";
  import ReviewCard from "./ReviewCard.svelte";

  const rows = $derived(app.rows);
  const sel = $derived(app.rvs.sel);
  const anyAgents = $derived(rows.some((r) => r.section === "review" && r.agents.length > 0));

  let scroller: HTMLDivElement | undefined = $state();
  /** Scrolls caused by a jump are not the user reaching a file. */
  let quietUntil = 0;

  function cardOf(id: string): HTMLElement | null {
    return scroller?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`) ?? null;
  }

  // A file selected from the keyboard or the tree: bring it to the top.
  $effect(() => {
    const id = sel;
    if (!id) return;
    if (id === stackSel.onScreen) {
      stackSel.onScreen = null;
      return;
    }
    void tick().then(() => {
      const el = cardOf(id);
      if (!el || !scroller) return;
      const top = el.offsetTop - 8;
      if (Math.abs(scroller.scrollTop - top) < 2) return;
      quietUntil = performance.now() + 200;
      scroller.scrollTop = top;
    });
  });

  /**
   * An editor that keeps the focus writes its selection again each time it redraws, and the
   * webview then scrolls back to it: once the cursor is off screen, the editor lets go of it.
   */
  function releaseOffscreenCursor() {
    const active = document.activeElement;
    if (!scroller || !(active instanceof HTMLElement) || !scroller.contains(active)) return;
    // CodeMirror draws its own cursor; a collapsed DOM range can measure as an empty box.
    const cursor = active.closest(".cm-editor")?.querySelector<HTMLElement>(".cm-cursor-primary");
    const r = (cursor ?? active).getBoundingClientRect();
    if (!r.height && !r.width) return;
    const box = scroller.getBoundingClientRect();
    if (r.bottom < box.top || r.top > box.bottom) active.blur();
  }

  function onScroll() {
    releaseOffscreenCursor();
    if (!scroller || performance.now() < quietUntil) return;
    const line = scroller.scrollTop + 48;
    let at: string | null = null;
    for (const el of scroller.querySelectorAll<HTMLElement>("[data-row]")) {
      if (el.offsetTop <= line) at = el.dataset.row ?? null;
      else break;
    }
    if (at && at !== sel) {
      stackSel.onScreen = at;
      app.rvSeen(at);
    }
  }
</script>

<section class="diff" class:focused={app.rvs.focus === "diff"} aria-label="Diff">
  {#if !rows.length}
    <div class="allclear">
      <h3>{app.sections.counts.done ? "Everything is reviewed" : "Nothing to review"}</h3>
      <span>
        {#if app.sections.counts.done}Press <Kbd k="C" /> to commit{:else}Changes of agents and your own edits show here{/if}
      </span>
    </div>
  {:else}
    <div class="bar">
      <span class="count">
        {app.sections.counts.review ? `${app.sections.counts.review} to review` : "All reviewed"}{#if app.sections.counts.done}<span class="faint">&nbsp;· {app.sections.counts.done} accepted</span>{/if}
      </span>
      <span class="grow"></span>
      {#if anyAgents}
        <div class="seg" role="group" aria-label="Compare with">
          <button class:on={app.rvCompare === "incoming"} onclick={() => (app.rvCompare = "incoming")} title="Only what the agents change in your files">Agent changes</button>
          <button class:on={app.rvCompare === "commit"} onclick={() => (app.rvCompare = "commit")} title="Everything since the last commit, your edits included">All since commit</button>
        </div>
      {/if}
      <div class="seg" role="group" aria-label="Layout">
        <button class:on={!app.rvSplit} onclick={() => app.rvSplit && app.dispatch({ type: "rv-split" })}>Unified</button>
        <button class:on={app.rvSplit} onclick={() => !app.rvSplit && app.dispatch({ type: "rv-split" })}>Side by side</button>
      </div>
    </div>
    <div class="stack" bind:this={scroller} onscroll={onScroll}>
      {#each rows as r (r.id)}
        <ReviewCard row={r} selected={r.id === sel} root={scroller} />
      {/each}
      <div class="end">
        {#if app.sections.counts.review}
          {app.sections.counts.review} left · <Kbd k="Space" /> accepts the selected file
        {:else}
          Everything is reviewed · <Kbd k="C" /> to commit
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .diff {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--raised);
    border-radius: 14px;
    overflow: hidden;
  }
  .bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 12.5px;
    color: var(--muted);
  }
  .count {
    font-weight: 600;
    color: var(--fg);
  }
  .faint {
    font-weight: 400;
    color: var(--faint);
  }
  .grow {
    flex: 1;
  }
  .seg {
    display: inline-flex;
    padding: 2px;
    border-radius: 8px;
    background: var(--hover);
  }
  .seg button {
    all: unset;
    cursor: pointer;
    font-size: 12px;
    padding: 3px 9px;
    border-radius: 6px;
    color: var(--muted);
  }
  .seg button.on {
    background: var(--panel);
    color: var(--fg);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.15);
  }
  .stack {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 8px;
    background: var(--panel);
  }
  .end {
    padding: 16px 0 40vh;
    text-align: center;
    font-size: 12.5px;
    color: var(--faint);
  }
  .allclear {
    padding: 48px 20px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    color: var(--muted);
  }
  .allclear h3 {
    margin: 0;
    color: var(--fg);
    font-size: 18px;
    font-weight: 600;
  }
</style>
