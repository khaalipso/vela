<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "../lib/app.svelte";
  import Kbd from "./Kbd.svelte";

  let name: HTMLInputElement | undefined = $state();
  onMount(() => name?.focus());

  $effect(() => {
    if (app.newSp.missingName) name?.focus();
  });
  onMount(() => {
    if (app.sheetMode === "add") document.getElementById("ns-repo")?.focus();
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={(e) => e.target === e.currentTarget && app.closeOverlay()}>
  <div class="sheet" role="dialog" aria-label={app.sheetMode === "add" ? "Add repos" : "New space"}>
    <form
      class="form"
      onsubmit={(e) => {
        e.preventDefault();
        void (app.sheetMode === "add" ? app.addRepos() : app.createSpace());
      }}
    >
      <div class="title">{app.sheetMode === "add" ? `Add repos to ${app.space.name}` : "New space"}</div>
      {#if app.sheetMode === "new"}
      <div class="grp">
        <label for="ns-name">What are you working on?</label>
        <input
          class="field"
          id="ns-name"
          autocomplete="off"
          placeholder={app.newSp.missingName ? "Give the space a name first" : "Refunds in checkout (optional with one repo)"}
          bind:this={name}
          bind:value={app.newSp.name}
          oninput={() => (app.newSp.missingName = false)}
        />
      </div>
      {/if}
      <div class="grp">
        <div class="lblrow">
          <label class="lbl" for="ns-repo">Repos for this task</label>
          <button type="button" class="link" onclick={() => void app.openNewRepo()} aria-expanded={app.newRepo.open}>+ New repo</button>
        </div>
        {#if app.newRepo.open}
          <div class="newrepo">
            <div class="nrf">
              <label class="lbl" for="nr-name">Name</label>
              <input class="field small" id="nr-name" autocomplete="off" spellcheck="false" placeholder="my-service" bind:value={app.newRepo.name}
                onkeydown={(e) => { if (e.key === "Enter" && !e.ctrlKey) { e.preventDefault(); void app.createRepo(); } }} />
            </div>
            <div class="nrf grow">
              <label class="lbl" for="nr-parent">In folder</label>
              <input class="field small mono" id="nr-parent" autocomplete="off" spellcheck="false" bind:value={app.newRepo.parent}
                onkeydown={(e) => { if (e.key === "Enter" && !e.ctrlKey) { e.preventDefault(); void app.createRepo(); } }} />
            </div>
            <button type="button" class="btn" onclick={() => void app.createRepo()}>Create repo</button>
          </div>
          <span class="hint">git init on main, a README and a first commit. The repo is then selected below.</span>
        {/if}
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
      <div class="cost">{app.sheetMode === "add" ? `Each repo gets a worktree on ${app.space.branch}.` : "Vela creates one branch and one worktree per repo, then starts the stack from mise.toml and compose.yml."}</div>
      <div class="actions">
        <button type="button" class="btn" onclick={() => app.closeOverlay()}>Cancel</button>
        <button type="submit" class="btn p">{app.sheetMode === "add" ? "Add to space" : "Create space"} <Kbd k="Ctrl Enter" /></button>
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
  .lblrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .link {
    font-size: 12px;
    font-weight: 600;
    color: var(--space);
    padding: 2px 4px;
    border-radius: 4px;
  }
  .link:hover {
    background: var(--hover);
  }
  .newrepo {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-wrap: wrap;
    padding: 10px;
    border-radius: 10px;
    background: var(--raised);
  }
  .nrf {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1 1 140px;
  }
  .nrf.grow {
    flex: 2 1 220px;
  }
  .hint {
    font-size: 12px;
    color: var(--faint);
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
