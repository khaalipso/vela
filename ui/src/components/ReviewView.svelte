<script lang="ts">
  import { tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { ROLE_COLORS, roleLabel, toolLabel } from "../lib/format";
  import DiffBlock from "./DiffBlock.svelte";
  import Kbd from "./Kbd.svelte";

  const total = $derived(app.proposals.length);
  const done = $derived(app.accepted.length + app.rejected.length);
  const focusId = $derived(app.focused?.hunk.id ?? null);
  let root: HTMLDivElement | undefined = $state();

  $effect(() => {
    focusId;
    void tick().then(() => {
      root?.querySelector<HTMLElement>("[data-focus='true']")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  });
</script>

<div class="rv" bind:this={root}>
  <div class="rvhead">
    <h2>Review</h2>
    <div class="bar"><i style:width="{total ? (done / total) * 100 : 100}%"></i></div>
    <span class="counts">{app.pending.length} to review · {app.accepted.length} accepted · {app.rejected.length} rejected</span>
  </div>
  {#if !total || !app.pending.length}
    <div class="allclear">
      <h3>{total ? "All proposals reviewed" : "No proposals yet"}</h3>
      <span>
        {#if app.readyToCommit}Press <Kbd k="C" /> to run the commit gate{:else}Agents will drop their changes here{/if}
      </span>
    </div>
  {/if}
  {#each app.proposals as p (p.hunk.id)}
    {@const h = p.hunk}
    {@const foc = h.id === focusId}
    {#if h.state !== "pending"}
      {@const col = h.state === "rejected" ? "var(--del)" : "var(--add)"}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <article class="hunk done" class:focus={foc} data-focus={foc} onclick={() => (app.cui.hi = h.id)}>
        <div class="hh">
          <span class="dot" style:--c={col}></span>
          <b>{h.repo}</b>
          <span class="loc">{h.path}:{h.newStart}</span>
          <span>{p.why}</span>
          <span class="keys">
            <span class="state" style:--c={col}>{p.edited ? "edited by you" : h.state === "rejected" ? "rejected" : "accepted"}</span>
            {#if foc}<Kbd k="U" /> undo{/if}
          </span>
        </div>
      </article>
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <article class="hunk" class:focus={foc} data-focus={foc} onclick={() => (app.cui.hi = h.id)}>
        <div class="hh">
          <span class="dot" style:--c={ROLE_COLORS[p.role]}></span>
          <b>{roleLabel(p.role)}</b>
          <span>{toolLabel(p.tool)}</span>
          <span class="loc">{h.repo} / {h.path}:{h.newStart}</span>
          {#if foc}
            <span class="keys">
              <span><Kbd k="Y" /> accept</span>
              <span><Kbd k="N" /> reject</span>
              <span><Kbd k="E" /> edit</span>
            </span>
          {/if}
        </div>
        <div class="why">{p.why}</div>
        <DiffBlock hunk={h} />
        {#if p.note && !p.note.resolved}
          <div class="note">
            <span class="dot" style:--c="var(--del)"></span>
            <div><small>{p.note.by} · blocking</small><span>{p.note.text}</span></div>
            <button
              class="btn"
              onclick={(e) => {
                e.stopPropagation();
                void app.askFix(h.id);
              }}
            >
              {#if p.note.busy}<span class="pulse">Fixing…</span>{:else}Ask to fix <Kbd k="F" />{/if}
            </button>
          </div>
        {/if}
      </article>
    {/if}
  {/each}
</div>

<style>
  .rv {
    max-width: 920px;
    margin: 0 auto;
    padding: 20px 20px 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .rvhead {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 0 4px 6px;
  }
  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
  .bar {
    flex: 1;
    min-width: 120px;
    height: 4px;
    border-radius: 9999px;
    background: var(--hover);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--space);
    transition: width 400ms var(--ease);
  }
  .counts {
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .hunk {
    background: var(--raised);
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 0 0 1px transparent;
    transition:
      box-shadow 240ms var(--ease),
      opacity 240ms var(--ease);
  }
  .hunk.focus {
    box-shadow: 0 0 0 2px var(--space);
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
  .hunk.done {
    opacity: 0.72;
  }
  .hunk.done .hh {
    padding: 8px 14px;
  }
  .state {
    font-size: 12px;
    font-weight: 600;
    color: var(--c);
  }
  .allclear {
    padding: 56px 20px;
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
