<script lang="ts">
  import { app } from "../lib/app.svelte";
  import LinkMark from "./LinkMark.svelte";
  import ViewSwitch from "./ViewSwitch.svelte";

  const chips = $derived(app.chips);
</script>

<div class="top">
  <h1><span class="dot"></span>{app.space.name}</h1>
  {#if chips.shown.length}
    <div class="lks" aria-label="Links">
      {#each chips.shown as l (l.id)}
        <button
          class="lk"
          title={l.url || `${l.key ?? l.title}: no tracker URL configured`}
          onclick={() => app.openLink(l.id)}
        >
          <LinkMark link={l} /><span class="lt">{l.key && l.kind === "issue" ? l.key : l.title}</span>
        </button>
      {/each}
      {#if chips.more > 0}
        <button class="lk more" title="All links" onclick={() => app.openLinks()}>+{chips.more}</button>
      {/if}
    </div>
  {/if}
  <button class="filesbtn" aria-pressed={app.filesOpen} title="Show or hide the files (B)" onclick={() => app.dispatch({ type: "toggle-files" })}>
    <svg width="14" height="14" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="20" stroke-linejoin="round" aria-hidden="true"><path d="M32 72a16 16 0 0 1 16-16h48l24 24h88a16 16 0 0 1 16 16v96a16 16 0 0 1-16 16H48a16 16 0 0 1-16-16z"></path></svg>
    Files <kbd>B</kbd>
  </button>
  <div class="chips">
    {#each app.space.repos as r (r.name)}
      <span class="chip">
        <button class="chipb" title={r.worktree} onclick={() => { if (!app.filesOpen) app.dispatch({ type: "toggle-files" }); }}><b>{r.name}</b><span class="mono">{app.space.branch}</span></button>
        {#if app.space.repos.length > 1}
          <button class="rm" aria-label={`Remove ${r.name} from this space`} title="Remove from this space (its worktree must be clean)" onclick={() => app.dispatch({ type: "remove-repo", repo: r.name })}>×</button>
        {/if}
      </span>
    {/each}
    <button class="addrepo" title="Add a repo to this space" onclick={() => app.dispatch({ type: "open-addrepo" })}>+ repo</button>
  </div>
  <ViewSwitch />
</div>

<style>
  .top {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    min-height: 44px;
    padding: 4px 4px 0;
  }
  h1 {
    margin: 0;
    font-size: 18px;
    line-height: 28px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  h1 .dot {
    width: 10px;
    height: 10px;
    background: var(--space);
  }
  .chipb {
    display: flex;
    align-items: center;
    gap: 6px;
    color: inherit;
  }
  .rm {
    width: 18px;
    height: 18px;
    border-radius: 4px;
    color: var(--faint);
    display: none;
    place-items: center;
  }
  .chip:hover .rm,
  .rm:focus-visible {
    display: grid;
  }
  .rm:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .addrepo {
    height: 28px;
    padding: 0 10px;
    border-radius: 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .addrepo:hover {
    background: var(--panel);
    color: var(--fg);
  }
  .filesbtn {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: 8px;
    background: var(--panel);
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
  }
  .filesbtn[aria-pressed="true"] {
    background: var(--hover);
    color: var(--fg);
  }
  .filesbtn kbd {
    font-family: var(--code);
    font-size: 11px;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--hover);
  }
  .chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: 8px;
    background: var(--panel);
    font-size: 12px;
    color: var(--muted);
  }
  .lks {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .lk {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    max-width: 200px;
    padding: 0 10px 0 6px;
    border-radius: 8px;
    background: var(--panel);
    font-size: 12px;
    color: var(--fg);
  }
  .lk:hover {
    background: var(--hover);
  }
  .lk.more {
    padding: 0 8px;
    color: var(--muted);
  }
  .lt {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip b {
    color: var(--fg);
    font-weight: 600;
  }
</style>
