<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "../lib/app.svelte";
  import Kbd from "./Kbd.svelte";

  let name: HTMLInputElement | undefined = $state();
  onMount(() => name?.focus());

  $effect(() => {
    if (app.newSp.missingName) name?.focus();
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={(e) => e.target === e.currentTarget && app.closeOverlay()}>
  <div class="sheet" role="dialog" aria-label="New space">
    <form
      class="form"
      onsubmit={(e) => {
        e.preventDefault();
        void app.createSpace();
      }}
    >
      <div class="title">New space</div>
      <div class="grp">
        <label for="ns-name">What are you working on?</label>
        <input
          class="field"
          id="ns-name"
          autocomplete="off"
          placeholder={app.newSp.missingName ? "Give the space a name first" : "Refunds in checkout"}
          bind:this={name}
          bind:value={app.newSp.name}
          oninput={() => (app.newSp.missingName = false)}
        />
      </div>
      <div class="grp">
        <span class="lbl">Repos for this task</span>
        <div class="repos">
          {#each app.repos as r (r)}
            <button type="button" class="rtog" aria-pressed={app.newSp.repos.includes(r)} onclick={() => app.toggleRepo(r)}>{r}</button>
          {/each}
        </div>
      </div>
      <div class="cost">Vela creates one branch and one worktree per repo, then starts the stack from mise.toml and compose.yml.</div>
      <div class="actions">
        <button type="button" class="btn" onclick={() => app.closeOverlay()}>Cancel</button>
        <button type="submit" class="btn p">Create space <Kbd k="Ctrl Enter" /></button>
      </div>
    </form>
  </div>
</div>

<style>
  .title {
    font-size: 16px;
    font-weight: 600;
  }
  .grp {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .lbl {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
  }
  .repos {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .rtog {
    height: 32px;
    padding: 0 12px;
    border-radius: 8px;
    background: var(--hover);
    font-size: 13px;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .rtog[aria-pressed="true"] {
    background: var(--space);
    color: var(--on-accent);
    font-weight: 600;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
