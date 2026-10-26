<script lang="ts">
  import { app } from "../lib/app.svelte";
  import LinkMark from "./LinkMark.svelte";
  import ViewSwitch from "./ViewSwitch.svelte";

  const chips = $derived(app.chips);
</script>

<div class="top">
  <h1><span class="dot"></span>{app.space.name}</h1>
  {#if chips.shown.length}
    <div class="lks" aria-label="Links">
      {#each chips.shown as l (l.id)}
        <button
          class="lk"
          title={l.url || `${l.key ?? l.title}: no tracker URL configured`}
          onclick={() => app.openLink(l.id)}
        >
          <LinkMark link={l} /><span class="lt">{l.key && l.kind === "issue" ? l.key : l.title}</span>
        </button>
      {/each}
      {#if chips.more > 0}
        <button class="lk more" title="All links" onclick={() => app.openLinks()}>+{chips.more}</button>
      {/if}
    </div>
  {/if}
  <div class="chips">
    {#each app.space.repos as r (r.name)}
      <span class="chip"><b>{r.name}</b><span class="mono">{r.worktree}</span></span>
    {/each}
  </div>
  <ViewSwitch />
</div>

<style>
  .top {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    min-height: 44px;
    padding: 4px 4px 0;
  }
  h1 {
    margin: 0;
    font-size: 18px;
    line-height: 28px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  h1 .dot {
    width: 10px;
    height: 10px;
    background: var(--space);
  }
  .chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: 8px;
    background: var(--panel);
    font-size: 12px;
    color: var(--muted);
  }
  .lks {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .lk {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    max-width: 200px;
    padding: 0 10px 0 6px;
    border-radius: 8px;
    background: var(--panel);
    font-size: 12px;
    color: var(--fg);
  }
  .lk:hover {
    background: var(--hover);
  }
  .lk.more {
    padding: 0 8px;
    color: var(--muted);
  }
  .lt {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip b {
    color: var(--fg);
    font-weight: 600;
  }
</style>
