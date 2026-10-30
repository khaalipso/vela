<script lang="ts">
  // The long pastes of a field, as chips. A click breaks the chip: the text comes back.
  import { pastedIn, restorePasted } from "../lib/paste";

  let { text = $bindable() }: { text: string } = $props();
  const chips = $derived(pastedIn(text));
</script>

{#if chips.length}
  <div class="chips" aria-label="Pasted texts">
    {#each chips as c (c.token)}
      <button type="button" class="chip" title="Click to paste the text into the field" onclick={() => (text = restorePasted(text, c.token))}>
        <svg width="12" height="12" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="64" y="40" width="144" height="176" rx="16" /><path d="M96 96h80M96 136h80M96 176h48" /></svg>
        Pasted text · {c.lines} lines
      </button>
    {/each}
  </div>
{/if}

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 12px 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-size: 12px;
    background: var(--hover);
    color: var(--muted);
  }
  .chip:hover {
    background: var(--line);
    color: var(--fg);
  }
</style>
