<script lang="ts">
  // A hunk before (left) and after (right).
  import { splitRows } from "../lib/review";
  import type { Hunk } from "../lib/types";

  let { hunk }: { hunk: Hunk } = $props();
  const rows = $derived(splitRows(hunk));
</script>

<div class="split" role="table" aria-label="Before and after">
  <div class="hd" role="row"><span role="columnheader">Before</span><span role="columnheader">After</span></div>
  {#each rows as r, i (i)}
    <div class="row" role="row">
      {#each [r.left, r.right] as c, side (side)}
        <div class="cell {c?.kind ?? 'empty'}" role="cell">
          <span class="g">{c?.n ?? ""}</span>
          <span class="s">{c?.kind === "add" ? "+" : c?.kind === "del" ? "−" : ""}</span>
          <span class="t">{c?.text ?? ""}</span>
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .split {
    font-family: var(--code);
    font-size: 13px;
    line-height: 22px;
    padding-bottom: 8px;
    overflow-x: auto;
  }
  .hd,
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 2px;
  }
  .hd {
    font-family: var(--ui);
    font-size: 11px;
    color: var(--faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0 0 4px 56px;
  }
  .cell {
    display: flex;
    gap: 8px;
    min-width: 0;
    white-space: pre;
    overflow: hidden;
  }
  .g {
    width: 40px;
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
  .t {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cell.add {
    background: var(--add-bg);
  }
  .cell.add .s {
    color: var(--add);
  }
  .cell.del {
    background: var(--del-bg);
    color: var(--muted);
  }
  .cell.del .s {
    color: var(--del);
  }
  .cell.empty {
    background: repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in srgb, var(--line) 35%, transparent) 6px 7px);
  }
</style>
