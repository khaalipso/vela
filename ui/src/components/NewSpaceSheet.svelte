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
        <label class="lbl" for="ns-repo">Repos for this task</label>
        <input
          class="field small"
          id="ns-repo"
          autocomplete="off"
          spellcheck="false"
          placeholder="Filter repos, or paste a folder path like ~/code/shop"
          bind:value={app.repoFilter}
          onkeydown={(e) => {
            if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              void app.repoFilterEnter();
            }
          }}
        />
        <div class="repos">
          {#each app.shownRepos as r (r)}
            <button type="button" class="rtog" aria-pressed={app.newSp.repos.includes(r)} title={r} onclick={() => app.toggleRepo(r)}>{r.split("/").pop()}</button>
          {:else}
            <span class="none">{app.repoFilter.trim().startsWith("/") || app.repoFilter.trim().startsWith("~") ? "Press Enter to add this folder" : app.repos.length ? "No repo matches" : "No git repo found under ~/Work. Paste a folder path above to add one."}</span>
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
    max-height: 168px;
    overflow: auto;
  }
  .field.small {
    height: 36px;
    font-size: 13px;
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
  .none {
    font-size: 12px;
    color: var(--muted);
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
