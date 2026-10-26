<script lang="ts">
  import { ROLE_COLORS, roleLabel, toolLabel } from "../lib/format";
  import type { AgentRole, Hunk } from "../lib/types";
  import DiffBlock from "./DiffBlock.svelte";
  import Kbd from "./Kbd.svelte";

  let {
    hunk,
    role,
    tool,
    why,
    focus,
    onfocus,
  }: { hunk: Hunk; role: AgentRole; tool: string; why: string; focus: boolean; onfocus: (id: string) => void } = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="inline" class:focus data-focus={focus} onmousedown={() => onfocus(hunk.id)}>
  <div class="ib">
    <span class="dot" style:--c={ROLE_COLORS[role]}></span>
    <b>{roleLabel(role)}</b>
    <span>{toolLabel(tool)} · {why}</span>
    <span class="keys">
      <span><Kbd k="Y" /> accept</span>
      <span><Kbd k="N" /> reject</span>
      <span><Kbd k="E" /> edit</span>
    </span>
  </div>
  <DiffBlock {hunk} numbers={false} />
</div>

<style>
  .inline {
    margin: 6px 16px 6px 8px;
    border-radius: 12px;
    background: var(--raised);
    overflow: hidden;
    box-shadow: 0 0 0 1px transparent;
    transition: box-shadow 240ms var(--ease);
    font-family: var(--ui);
  }
  .inline.focus {
    box-shadow: 0 0 0 2px var(--space);
  }
  .ib {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 8px 12px;
    font-family: var(--ui);
    font-size: 12px;
    color: var(--muted);
  }
  .ib b {
    color: var(--fg);
    font-weight: 600;
  }
  .keys {
    margin-left: auto;
    display: flex;
    gap: 10px;
  }
  .keys span {
    display: flex;
    gap: 6px;
    align-items: center;
  }
</style>
