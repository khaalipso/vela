<script lang="ts">
  // One change of yours, opened from its bar in the gutter: what the lines were and are,
  // and what to do with it (stage, unstage, revert, copy the old lines).
  import type { Hunk } from "../lib/types";
  import DiffBlock from "./DiffBlock.svelte";
  import Kbd from "./Kbd.svelte";

  let {
    hunk,
    index,
    total,
    onstage,
    onunstage,
    onrevert,
    oncopy,
    onclose,
    onmove,
  }: {
    hunk: Hunk;
    index: number;
    total: number;
    onstage: () => void;
    onunstage: () => void;
    onrevert: () => void;
    oncopy: () => void;
    onclose: () => void;
    onmove: (delta: 1 | -1) => void;
  } = $props();

  const staged = $derived(hunk.state === "staged");
  const removed = $derived(hunk.lines.filter((l) => l.kind === "del").length);
  const added = $derived(hunk.lines.filter((l) => l.kind === "add").length);
</script>

<div class="peek" class:staged role="dialog" aria-label="Change at line {hunk.newStart}">
  <header>
    <span class="st">{staged ? "Staged" : "Not staged"}</span>
    <span class="sz"><span class="a">+{added}</span> <span class="d">−{removed}</span></span>
    <span class="pos">{index + 1} of {total}</span>
    <button class="ic" title="Previous change (Ctrl Alt ↑)" aria-label="Previous change" onclick={() => onmove(-1)}>↑</button>
    <button class="ic" title="Next change (Ctrl Alt ↓)" aria-label="Next change" onclick={() => onmove(1)}>↓</button>
    <span class="acts">
      {#if staged}
        <button class="btn" onclick={onunstage}>Unstage</button>
      {:else}
        <button class="btn p" onclick={onstage}>Stage</button>
      {/if}
      <button class="btn danger" onclick={onrevert} title="Put these lines back as they were; you can undo it from the notification">Revert</button>
      {#if removed}<button class="btn" onclick={oncopy}>Copy original</button>{/if}
      <button class="ic" aria-label="Close" title="Close (Esc)" onclick={onclose}>×</button>
    </span>
  </header>
  <DiffBlock {hunk} />
  <footer><Kbd k="Esc" /> close</footer>
</div>

<style>
  .peek {
    margin: 4px 0 4px 8px;
    border-radius: 12px;
    background: var(--raised);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--warn) 50%, transparent),
      0 10px 30px rgba(0, 0, 0, 0.25);
    overflow: hidden;
    font-size: 12px;
  }
  .peek.staged {
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--add) 50%, transparent),
      0 10px 30px rgba(0, 0, 0, 0.25);
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .st {
    font-weight: 600;
    color: var(--warn);
  }
  .staged .st {
    color: var(--add);
  }
  .sz {
    font-family: var(--code);
  }
  .a {
    color: var(--add);
  }
  .d {
    color: var(--del);
  }
  .pos {
    color: var(--faint);
  }
  .ic {
    color: var(--faint);
    padding: 0 6px;
    border-radius: 6px;
    font-size: 13px;
  }
  .ic:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .acts {
    margin-left: auto;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .acts .btn {
    height: 26px;
    font-size: 12px;
  }
  .danger:hover {
    background: var(--del-bg);
    color: var(--del);
  }
  footer {
    padding: 2px 10px 6px;
    color: var(--faint);
    font-size: 11px;
  }
</style>
