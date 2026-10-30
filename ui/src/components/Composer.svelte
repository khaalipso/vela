<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "../lib/app.svelte";
  import { ROLES, roleLabel, toolLabel } from "../lib/format";
  import type { Tier } from "../lib/types";
  import Kbd from "./Kbd.svelte";

  let ta: HTMLTextAreaElement | undefined = $state();
  onMount(() => ta?.focus());

  const TIER_LIST: Tier[] = ["high", "medium", "low"];
  const readOnly = $derived(app.role === "reviewer" || app.role === "planner");
</script>

{#if app.composerWide}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => app.closeOverlay()}></div>
{/if}
<div
  class="composer"
  class:wide={app.composerWide}
  role="dialog"
  aria-label="Ask an agent"
>
  <label for="cmp-in" class="psec"
    >Ask in {app.space.name} ·
    {#if readOnly}reads your worktree, changes nothing{:else}runs in a new worktree from your last commit; uncommitted changes are not copied{/if}</label
  >
  <textarea
    id="cmp-in"
    rows={app.composerWide ? 14 : 2}
    placeholder="Handle charge.refunded in the webhook"
    bind:this={ta}
    bind:value={app.composerText}
  ></textarea>
  <div class="row">
    {#each ROLES as r (r)}
      <button
        class="role"
        aria-pressed={app.role === r}
        onclick={() => {
          app.role = r;
          ta?.focus();
        }}>{roleLabel(r)}</button
      >
    {/each}
    <span class="hint"><Kbd k="Tab" /> role · <Kbd k="Enter" /> send · <Kbd k="Esc" /> close</span>
  </div>
  <div class="row" aria-label="Harness and tier">
    {#if app.installedHarnesses.length === 0}
      <span class="none">No agent CLI found on this machine (claude, codex or opencode).</span>
    {/if}
    {#each app.installedHarnesses as h (h.name)}
      <button
        class="role harness"
        aria-pressed={app.effectiveHarness === h.name}
        title={h.version ?? h.name}
        onclick={() => {
          app.harness = h.name;
          ta?.focus();
        }}>{toolLabel(h.name)}</button
      >
    {/each}
    <span class="sep"></span>
    {#each TIER_LIST as t (t)}
      <button
        class="role tier"
        aria-pressed={app.effectiveTier === t}
        onclick={() => {
          app.tier = t;
          ta?.focus();
        }}>{t}</button
      >
    {/each}
    <span class="hint"><Kbd k="Shift Tab" /> harness · <Kbd k="Ctrl ↑" /> <Kbd k="Ctrl ↓" /> tier</span>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 5;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(3px);
    animation: scrim-in 200ms ease-out;
  }
  @keyframes scrim-in {
    from {
      opacity: 0;
    }
  }
  @keyframes wide-in {
    from {
      opacity: 0;
      transform: translate(-50%, calc(-50% + 14px)) scale(0.97);
    }
  }
  .composer.wide {
    position: fixed;
    left: 50%;
    top: 50%;
    bottom: auto;
    transform: translate(-50%, -50%);
    width: min(880px, calc(100vw - 48px));
    max-height: calc(100vh - 64px);
    padding: 18px;
    gap: 12px;
    border-radius: 20px;
    z-index: 7;
    animation: wide-in 280ms var(--ease);
  }
  .composer.wide textarea {
    flex: 1;
    min-height: 260px;
    max-height: calc(100vh - 260px);
    overflow-y: auto;
    resize: none;
    font-size: 14.5px;
    line-height: 1.55;
    padding: 4px;
  }
  .composer {
    position: absolute;
    left: 50%;
    bottom: 52px;
    transform: translateX(-50%);
    z-index: 6;
    width: min(640px, calc(100% - 32px));
    background: var(--hover);
    border-radius: 18px;
    padding: 12px;
    box-shadow:
      0 12px 40px rgba(0, 0, 0, 0.35),
      0 0 0 1px var(--line);
    display: flex;
    flex-direction: column;
    gap: 10px;
    animation: pop 260ms var(--ease);
  }
  .psec {
    padding: 0 4px;
  }
  textarea {
    background: none;
    border: 0;
    outline: none;
    color: var(--fg);
    font: inherit;
    font-size: 15px;
    resize: none;
    min-height: 44px;
  }
  textarea::placeholder {
    color: var(--faint);
  }
  .row {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--faint);
  }
  .role {
    height: 26px;
    padding: 0 10px;
    border-radius: 9999px;
    background: var(--panel);
    font-size: 12px;
    color: var(--muted);
  }
  .role[aria-pressed="true"] {
    background: var(--space);
    color: var(--on-accent);
    font-weight: 600;
  }
  .hint {
    margin-left: auto;
  }
  .sep {
    width: 1px;
    height: 16px;
    background: var(--line);
    margin: 0 4px;
  }
  .none {
    color: var(--warn);
  }
</style>
