<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "../lib/app.svelte";
  import { ROLES, roleLabel } from "../lib/format";
  import Kbd from "./Kbd.svelte";

  let ta: HTMLTextAreaElement | undefined = $state();
  onMount(() => ta?.focus());
</script>

<div class="composer" role="dialog" aria-label="Ask an agent">
  <label for="cmp-in" class="psec">Ask in {app.space.name} · runs in a new worktree</label>
  <textarea
    id="cmp-in"
    rows="2"
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
</div>

<style>
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
</style>
