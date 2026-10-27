<script lang="ts">
  import { highlightLines, type Span } from "../lib/diffsyntax";
  import type { Hunk } from "../lib/types";

  let {
    hunk,
    numbers = true,
    onComment,
    marked,
  }: {
    hunk: Hunk;
    numbers?: boolean;
    /** Click on a line number: comment that line. */
    onComment?: (line: number) => void;
    /** Lines that already carry a comment or a note. */
    marked?: Set<number>;
  } = $props();

  let spans: Span[][] | null = $state(null);
  $effect(() => {
    const h = hunk;
    const key = `${h.id}:${h.lines.length}:${h.lines[0]?.text ?? ""}`;
    spans = null;
    void highlightLines(h.path, key, h.lines).then((s) => {
      if (h === hunk) spans = s;
    });
  });
</script>

<div class="diff" class:commentable={!!onComment}>
  {#each hunk.lines as l, i (i)}
    {@const n = l.new ?? l.old ?? 0}
    <div class="dl" class:a={l.kind === "add"} class:d={l.kind === "del"} class:mk={marked?.has(n)}>
      {#if numbers}
        {#if onComment}
          <button class="g" title="Comment this line" tabindex="-1" onclick={(e) => (e.stopPropagation(), onComment(n))}>
            <span class="o">{l.old ?? ""}</span><span class="n">{l.new ?? ""}</span><i class="plus">+</i>
          </button>
        {:else}
          <span class="g"><span class="o">{l.old ?? ""}</span><span class="n">{l.new ?? ""}</span></span>
        {/if}
      {/if}
      <span class="s">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
      <span class="t"
        >{#if spans?.[i]}{#each spans[i] as sp, j (j)}{#if sp.cls}<span class={sp.cls}>{sp.text}</span>{:else}{sp.text}{/if}{/each}{:else}{l.text}{/if}</span
      >
    </div>
  {/each}
</div>

<style>
  .diff {
    font-family: var(--code);
    font-size: 13.5px;
    line-height: 23px;
    overflow-x: auto;
    padding-bottom: 8px;
  }
  .dl {
    display: flex;
    gap: 10px;
    padding-right: 16px;
    white-space: pre;
    min-width: max-content;
  }
  .g {
    all: unset;
    flex: none;
    display: inline-flex;
    position: relative;
    color: var(--gutter);
    user-select: none;
    font-size: 12px;
  }
  .g .o,
  .g .n {
    width: 38px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .commentable .g {
    cursor: pointer;
  }
  .plus {
    position: absolute;
    left: 2px;
    top: 3px;
    width: 17px;
    height: 17px;
    border-radius: 5px;
    background: var(--space);
    color: var(--on-accent);
    font-style: normal;
    font-weight: 700;
    font-size: 13px;
    line-height: 17px;
    text-align: center;
    opacity: 0;
    transition: opacity 120ms var(--ease);
  }
  .commentable .dl:hover .plus {
    opacity: 1;
  }
  .dl.mk .g .n {
    color: var(--space);
    font-weight: 600;
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
  }
  .dl.d .t {
    opacity: 0.8;
  }
  .dl.d .s {
    color: var(--del);
  }
</style>
