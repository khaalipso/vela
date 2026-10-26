<script lang="ts">
  import { app } from "../lib/app.svelte";
  import type { View } from "../lib/keymap";
  import Kbd from "./Kbd.svelte";

  const views: [View, string, string][] = [
    ["code", "Code", "1"],
    ["review", "Review", "2"],
    ["agents", "Agents", "3"],
  ];
  const count = (v: View) => (v === "review" ? app.pending.length : v === "agents" ? (app.sd.question ? 1 : 0) : 0);
</script>

<div class="views" role="group" aria-label="View">
  {#each views as [v, label, k] (v)}
    <button aria-pressed={app.view === v} onclick={() => app.setView(v)}>
      {label}{#if count(v)}<span class="n">{count(v)}</span>{/if}
      <Kbd {k} />
    </button>
  {/each}
</div>

<style>
  .views {
    margin-left: auto;
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 10px;
    background: var(--panel);
  }
  button {
    height: 30px;
    padding: 0 10px;
    border-radius: 7px;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 13px;
    transition:
      background-color 240ms var(--ease),
      color 240ms var(--ease);
  }
  button[aria-pressed="true"] {
    background: var(--hover);
    color: var(--fg);
    font-weight: 600;
  }
  .n {
    font-size: 11px;
    font-weight: 600;
    color: var(--space);
  }
  @media (max-width: 760px) {
    .views {
      margin-left: 0;
    }
  }
</style>
