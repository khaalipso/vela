<script lang="ts">
  import { app } from "../lib/app.svelte";
  import { stackColor } from "../lib/format";
  import type { View } from "../lib/keymap";
  import Kbd from "./Kbd.svelte";

  const HINTS: Record<View, [string, string][]> = {
    review: [["J K", "move"], ["Y", "accept"], ["N", "reject"], ["E", "edit by hand"], ["F", "ask to fix"]],
    code: [["Click", "type anywhere"], ["J K", "proposals"], ["Y N", "accept, reject"], ["B", "files"], ["Ctrl P", "go to file"]],
    agents: [["@", "ask"], ["Y N", "answer"]],
  };
  const hints = $derived([...HINTS[app.view], ["C", "commit"], ["L", "links"], ["Ctrl K", "everything"]]);
  const stack = $derived(app.sd.stack);
  const starting = $derived(stack.filter((s) => s.state === "starting").length);
  const label = (s: { name: string; version: string | null }) => (s.version ? `${s.name} ${s.version}` : s.name);
</script>

<div class="bottom">
  <div class="hints">
    {#each hints as [k, t] (k)}
      <span><Kbd {k} />{t}</span>
    {/each}
  </div>
  <button class="stack" aria-expanded={app.stackOpen} onclick={() => app.dispatch({ type: "toggle-stack" })}>
    {#each stack.slice(0, 3) as s (s.name + s.version)}
      <span class="dot" style:--c={stackColor(s.state)}></span><span class="mono">{label(s)}</span>
    {/each}
    {#if stack.length > 3}<span>+{stack.length - 3}</span>{/if}
    {#if starting}<span style:color="var(--warn)">· {starting} starting</span>{/if}
    <Kbd k="S" />
  </button>
</div>

<style>
  .bottom {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    min-height: 32px;
    padding: 0 6px;
    font-size: 12px;
    color: var(--faint);
  }
  .hints {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    align-items: center;
  }
  .hints span {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .stack {
    margin-left: auto;
    display: flex;
    gap: 6px;
    align-items: center;
    height: 28px;
    padding: 0 10px;
    border-radius: 8px;
    transition: background-color 200ms var(--ease);
  }
  .stack:hover {
    background: var(--panel);
  }
  .stack .dot {
    width: 6px;
    height: 6px;
  }
  @media (max-width: 760px) {
    .hints {
      display: none;
    }
  }
</style>
