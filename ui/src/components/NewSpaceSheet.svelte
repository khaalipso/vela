<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "../lib/app.svelte";
  import { renderBranch } from "../lib/backend";
  import Kbd from "./Kbd.svelte";

  /** The repo whose branches are suggested: the first one picked. */
  const firstRepo = $derived(app.newSp.repos[0] ?? null);
  $effect(() => {
    if (app.sheetMode === "new") void app.loadBranchChoices(firstRepo);
  });
  const defaultBranch = $derived(renderBranch(app.branchTemplate, app.newSp.name || (firstRepo?.split("/").pop() ?? "my task"), app.newSp.ticket));
  /** The repos picked get the space branch unless you give one its own. */
  const own = $derived(app.newSp.repos.filter((r) => app.newSp.repoBranches[r]?.trim()));
  const typed = $derived(app.newSp.branch.trim());
  const match = $derived(
    typed ? app.sheetBranches.find((b) => b.name === typed || (b.remote && b.name.split("/").slice(1).join("/") === typed)) : undefined,
  );
  let showBranch = $state(false);

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
      <div class="grp">
        <label class="lbl" for="ns-ticket">Ticket <span class="opt">optional</span></label>
        <input
          class="field small mono"
          id="ns-ticket"
          autocomplete="off"
          spellcheck="false"
          placeholder="PAY-412, or the URL of the issue"
          bind:value={app.newSp.ticket}
        />
        {#if app.newSp.ticket.trim()}
          <span class="hint">In the Refs: footer of the commits and on the agents{app.branchTemplate.includes("{ticket}") ? ", and in the branch name" : ""}. You can change it later from the top bar.</span>
        {/if}
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
      {#if app.sheetMode === "new"}
        <div class="grp">
          <div class="lblrow">
            <label class="lbl" for="ns-branch">Branch</label>
            <button type="button" class="link" aria-expanded={showBranch} onclick={() => (showBranch = !showBranch)}>
              {showBranch ? "Hide" : (typed ? typed : defaultBranch) + (own.length ? ` · ${own.length} repo${own.length > 1 ? "s" : ""} on their own` : "")}
            </button>
          </div>
          {#if showBranch || typed}
            <div class="brow">
              <input
                class="field small mono"
                id="ns-branch"
                list="ns-branches"
                autocomplete="off"
                spellcheck="false"
                placeholder={defaultBranch}
                bind:value={app.newSp.branch}
              />
              <input
                class="field small mono base"
                id="ns-base"
                list="ns-bases"
                autocomplete="off"
                spellcheck="false"
                placeholder="from: current branch"
                aria-label="Base branch"
                disabled={!!match}
                bind:value={app.newSp.base}
              />
            </div>
            <datalist id="ns-branches">
              {#each app.sheetBranches as b (b.name)}<option value={b.name}>{b.when} · {b.subject}</option>{/each}
            </datalist>
            <datalist id="ns-bases">
              {#each app.sheetBranches as b (b.name)}<option value={b.name}>{b.when}</option>{/each}
            </datalist>
            {#if app.newSp.repos.length > 1}
              <div class="perrepo" aria-label="Branch of each repo">
                {#each app.newSp.repos as r (r)}
                  <label class="pr">
                    <span class="prn">{r.split("/").pop()}</span>
                    <input
                      class="field small mono"
                      autocomplete="off"
                      spellcheck="false"
                      placeholder={typed || defaultBranch}
                      aria-label="Branch of {r.split('/').pop()}"
                      bind:value={app.newSp.repoBranches[r]}
                    />
                  </label>
                {/each}
              </div>
            {/if}
            <span class="hint" data-branch-hint>
              {#if match}
                {match.remote ? `Takes ${match.name} as a local branch that tracks it` : `Uses the existing branch ${match.name} as it is`}{match.when ? ` (last commit ${match.when})` : ""}.
              {:else if typed}
                A new branch {typed}, from {app.newSp.base.trim() || "the current branch of each repo"}.
              {:else}
                Empty: {defaultBranch} (pattern <span class="mono">{app.branchTemplate}</span>, change it in Settings). Pick an existing or remote branch to work on it.
              {/if}
            </span>
          {/if}
        </div>
      {/if}
      {#if app.sheetMode === "add"}
        <div class="grp">
          <label class="lbl" for="ns-addbranch">Branch</label>
          <input
            class="field small mono"
            id="ns-addbranch"
            autocomplete="off"
            spellcheck="false"
            placeholder={app.space.branch}
            bind:value={app.newSp.branch}
          />
        </div>
      {/if}
      <div class="cost">{app.sheetMode === "add" ? `Each repo gets a worktree on ${app.newSp.branch.trim() || app.space.branch}: an existing branch is used as it is.` : "Vela creates a branch and a worktree per repo (each repo can have its own branch), then starts the stack from mise.toml and compose.yml."}</div>
      <div class="actions">
        <button type="button" class="btn" onclick={() => app.closeOverlay()}>Cancel</button>
        <button type="submit" class="btn p">{app.sheetMode === "add" ? "Add to space" : "Create space"} <Kbd k="Ctrl Enter" /></button>
      </div>
    </form>
  </div>
</div>

<style>
  .opt {
    font-weight: 400;
    color: var(--faint);
    margin-left: 4px;
  }
  .perrepo {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pr {
    display: grid;
    grid-template-columns: 110px 1fr;
    align-items: center;
    gap: 8px;
  }
  .prn {
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
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
  .brow {
    display: flex;
    gap: 8px;
  }
  .brow .field {
    flex: 1;
    min-width: 0;
  }
  .brow .base {
    flex: 0 0 38%;
  }
  .hint {
    font-size: 12px;
    color: var(--faint);
  }
  .mono {
    font-family: var(--code);
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
