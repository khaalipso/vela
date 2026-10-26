<script lang="ts">
  import type { Hunk } from "../lib/types";

  let { hunk, numbers = true }: { hunk: Hunk; numbers?: boolean } = $props();
</script>

<div class="diff">
  {#each hunk.lines as l, i (i)}
    <div class="dl" class:a={l.kind === "add"} class:d={l.kind === "del"}>
      {#if numbers}<span class="g">{l.old ?? l.new}</span>{/if}
      <span class="s">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
      <span>{l.text}</span>
    </div>
  {/each}
</div>

<style>
  .diff {
    font-family: var(--code);
    font-size: 13px;
    line-height: 22px;
    overflow-x: auto;
    padding-bottom: 8px;
  }
  .dl {
    display: flex;
    gap: 12px;
    padding-right: 16px;
    white-space: pre;
  }
  .g {
    width: 44px;
    flex: none;
    text-align: right;
    color: var(--gutter);
    user-select: none;
  }
  .s {
    width: 10px;
    flex: none;
    user-select: none;
  }
  .dl.a {
    background: var(--add-bg);
  }
  .dl.a .s {
    color: var(--add);
  }
  .dl.d {
    background: var(--del-bg);
    color: var(--muted);
  }
  .dl.d .s {
    color: var(--del);
  }
</style>
