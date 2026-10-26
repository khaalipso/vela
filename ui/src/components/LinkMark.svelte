<script lang="ts">
  import { providerMark } from "../lib/links";
  import type { Link } from "../lib/types";

  let { link }: { link: Pick<Link, "provider" | "kind"> } = $props();
  const m = $derived(providerMark(link));
</script>

<span class="mark" style:--c={m.color} aria-hidden="true">{m.text}</span>

<style>
  .mark {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 3px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--c) 16%, transparent);
    color: var(--c);
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0.01em;
  }
</style>
