<script lang="ts">
  import { app } from "../lib/app.svelte";
  import ViewSwitch from "./ViewSwitch.svelte";
</script>

<div class="top">
  <h1><span class="dot"></span>{app.space.name}</h1>
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
  .chip b {
    color: var(--fg);
    font-weight: 600;
  }
</style>
