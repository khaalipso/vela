<script lang="ts">
  import { tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { openAtEvent } from "../lib/contextmenu.svelte";
  import { hunkMenu } from "../lib/menus";
  import { ROLE_COLORS, roleLabel, toolLabel } from "../lib/format";
  import { SECTION_TITLES } from "../lib/review";
  import type { ReviewNote } from "../lib/backend";
  import DiffBlock from "./DiffBlock.svelte";
  import Kbd from "./Kbd.svelte";
  import SplitDiff from "./SplitDiff.svelte";

  const row = $derived(app.selectedRow);
  const hunks = $derived(app.selectedHunks);
  const cursor = $derived(app.rvs.hunk);
  const total = $derived(app.proposals.length);
  const done = $derived(app.accepted.length + app.rejected.length);
  let root: HTMLElement | undefined = $state();

  $effect(() => {
    cursor;
    row?.id;
    void tick().then(() => root?.querySelector<HTMLElement>("[data-focus='true']")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  });

  const proposalOf = (id: string) => app.proposals.find((p) => p.hunk.id === id);
  const notes = $derived(row ? app.notesOf(row.repo, row.path) : []);
  const hunkIds = $derived(new Set(hunks.map((h) => h.id)));
  /** Notes of the file that fall in none of the hunks shown. */
  const fileNotes = $derived(notes.filter((n) => !n.hunkId || !hunkIds.has(n.hunkId)));
  const notesOfHunk = (id: string) => notes.filter((n) => n.hunkId === id);
  const LEVEL_COLOR: Record<ReviewNote["level"], string> = { blocking: "var(--del)", warning: "var(--warn)", info: "var(--info)" };
</script>

<section class="diff" bind:this={root} class:focused={app.rvs.focus === "diff"} aria-label="Diff">
  {#if !row}
    <div class="allclear">
      <h3>Nothing selected</h3>
      <span>Pick a file on the left with <Kbd k="J" /> and <Kbd k="K" /></span>
    </div>
  {:else}
    <header class="dh">
      <b class="path">{row.repo} / {row.path}</b>
      <span class="badge">{SECTION_TITLES[row.section]}</span>
      {#if total}
        <span class="prog">{done} of {total} proposals reviewed</span>
      {/if}
      <button class="mode" onclick={() => app.dispatch({ type: "rv-split" })} title="Before and after side by side, or one column">
        {app.rvSplit ? "Side by side" : "Unified"} <Kbd k="V" />
      </button>
      <span class="keys"><Kbd k="Tab" /> next hunk <Kbd k="Y" /> stage <Kbd k="U" /> unstage</span>
    </header>
    {#each fileNotes as n (n.id)}
      {@render note(n)}
    {/each}
    {#if !hunks.length}
      <div class="allclear">
        <h3>No hunks to show</h3>
        <span>This file was staged before, as a whole. Unstage it with <Kbd k="Space" />.</span>
      </div>
    {/if}
    {#each hunks as h, i (h.id)}
      {@const p = proposalOf(h.id)}
      {@const foc = i === cursor}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <article
        class="hunk"
        class:focus={foc}
        class:staged={h.state === "staged"}
        class:done={h.state === "staged" && !!p}
        data-focus={foc}
        data-state={h.state}
        onclick={() => app.rvHunkSet(i)}
        oncontextmenu={(e) => {
          app.rvHunkSet(i);
          openAtEvent(e, hunkMenu(h), "Hunk");
        }}
      >
        <div class="hh">
          {#if p}
            <span class="dot" style:--c={ROLE_COLORS[p.role]}></span>
            <b>{roleLabel(p.role)}</b>
            <span>{toolLabel(p.tool)}</span>
          {:else}
            <span class="dot" style:--c="var(--info)"></span>
            <b>You</b>
          {/if}
          <span class="loc">line {h.newStart}{h.section ? ` · ${h.section}` : ""}</span>
          <span class="keys">
            {#if h.state === "staged"}
              <span class="state">{p?.edited ? "edited by you" : "staged"}</span>
              {#if foc}<span><Kbd k="U" /> unstage</span>{/if}
            {:else if foc}
              <span><Kbd k="Y" /> {p ? "accept" : "stage"}</span>
              {#if p}<span><Kbd k="N" /> reject</span><span><Kbd k="E" /> edit</span>{/if}
            {/if}
          </span>
        </div>
        {#if p?.why}<div class="why">{p.why}</div>{/if}
        {#if app.rvSplit}<SplitDiff hunk={h} />{:else}<DiffBlock hunk={h} />{/if}
        {#each notesOfHunk(h.id) as n (n.id)}
          {@render note(n)}
        {/each}
      </article>
    {/each}
  {/if}
</section>

{#snippet note(n: ReviewNote)}
  <div class="note" class:resolved={n.resolved} data-note={n.id}>
    <span class="dot" style:--c={n.resolved ? "var(--add)" : LEVEL_COLOR[n.level]}></span>
    <div>
      <small>{n.by} · {n.resolved ? "resolved" : n.level} · line {n.line}</small>
      <span>{n.text}</span>
    </div>
    {#if !n.resolved}
      <button
        class="btn"
        disabled={n.busy}
        onclick={(e) => {
          e.stopPropagation();
          void app.askFix(n.id);
        }}
      >
        {#if n.busy}<span class="pulse">Fixing…</span>{:else}Ask to fix <Kbd k="F" />{/if}
      </button>
      <button
        class="btn"
        onclick={(e) => {
          e.stopPropagation();
          void app.resolveNote(n.id, true);
        }}>Resolve <Kbd k="Shift Y" /></button
      >
    {:else}
      <button
        class="btn"
        onclick={(e) => {
          e.stopPropagation();
          void app.resolveNote(n.id, false);
        }}>Reopen</button
      >
    {/if}
  </div>
{/snippet}

<style>
  .diff {
    min-width: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 2px 2px 12px;
  }
  .dh {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 4px 6px;
    font-size: 12px;
    color: var(--muted);
    position: sticky;
    top: 0;
    background: var(--panel);
    z-index: 1;
  }
  .path {
    font-family: var(--code);
    color: var(--fg);
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .badge {
    padding: 1px 8px;
    border-radius: 9999px;
    background: var(--hover);
  }
  .hunk {
    background: var(--raised);
    border-radius: 14px;
    overflow: hidden;
    box-shadow:
      0 0 0 1px transparent,
      inset 3px 0 0 transparent;
    transition:
      box-shadow 240ms var(--ease),
      opacity 240ms var(--ease);
    flex: none;
  }
  .hunk.staged {
    box-shadow: inset 3px 0 0 var(--add);
  }
  .hunk.staged :global(.dl.a) {
    background: color-mix(in srgb, var(--add) 18%, transparent);
  }
  .hunk.focus {
    box-shadow: 0 0 0 2px var(--space);
  }
  .hunk.focus.staged {
    box-shadow:
      0 0 0 2px var(--space),
      inset 3px 0 0 var(--add);
  }
  .hh {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 10px 14px;
    font-size: 12px;
    color: var(--muted);
  }
  .hh b {
    color: var(--fg);
    font-weight: 600;
    font-size: 13px;
  }
  .loc {
    font-family: var(--code);
    color: var(--faint);
  }
  .keys {
    margin-left: auto;
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .state {
    font-weight: 600;
    color: var(--add);
  }
  .why {
    padding: 0 14px 10px;
    font-size: 13px;
    color: var(--fg);
  }
  .note {
    margin: 4px 14px 14px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--hover);
    display: flex;
    gap: 10px;
    align-items: flex-start;
    font-size: 13px;
  }
  .note .dot {
    margin-top: 6px;
  }
  .note.resolved {
    opacity: 0.6;
  }
  .mode {
    font-size: 12px;
    color: var(--muted);
    display: inline-flex;
    gap: 6px;
    align-items: center;
    padding: 2px 8px;
    border-radius: 8px;
  }
  .mode:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .note div {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .note small {
    font-size: 12px;
    font-weight: 600;
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
