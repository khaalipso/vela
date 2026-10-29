<script lang="ts">
  import { colorOfRepo } from "../lib/colors";
  import { app } from "../lib/app.svelte";
  import { openAtEvent } from "../lib/contextmenu.svelte";
  import { branchMenu, repoChipMenu, ticketMenu } from "../lib/menus";
  import { ops } from "../lib/ops.svelte";
  import { repoBranch, spaceBranches } from "../lib/types";
  import ViewSwitch from "./ViewSwitch.svelte";

  const branches = $derived(spaceBranches(app.space));
  /** The repos are on different branches: each chip shows its own. */
  const split = $derived(branches.length > 1);
  const branchTitle = $derived(
    split
      ? `Branches of this space: ${app.space.repos.map((r) => `${r.name} on ${repoBranch(app.space, r.name)}`).join(", ")}. Rename, copy, push`
      : `Branch of ${app.space.repos.length > 1 ? "every repo of this space" : "this space"}: rename, copy, push`,
  );
</script>

<div class="top">
  <h1><span class="dot"></span>{app.space.name}</h1>
  <button class="branch mono" title={branchTitle} aria-label={split ? `${branches.length} branches` : `Branch ${branches[0]}`} onclick={(e) => openAtEvent(e, branchMenu(), branches.join(", "))} oncontextmenu={(e) => openAtEvent(e, branchMenu(), branches.join(", "))}>
    <svg width="13" height="13" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" aria-hidden="true"><circle cx="72" cy="56" r="24" /><circle cx="72" cy="200" r="24" /><circle cx="184" cy="88" r="24" /><path d="M72 80v96M184 112c0 48-112 32-112 64" /></svg>
    {split ? `${branches.length} branches` : branches[0]}
  </button>
  {#if app.space.ticket}
    <button class="ticket mono" title="Ticket of this task: in the Refs footer of the commits. Click to change" aria-label="Ticket {app.space.ticket}" onclick={() => ops.askTicket()} oncontextmenu={(e) => openAtEvent(e, ticketMenu(), app.space.ticket ?? "")}>
      <svg width="12" height="12" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="20" stroke-linejoin="round" aria-hidden="true"><path d="M32 88V64a8 8 0 0 1 8-8h176a8 8 0 0 1 8 8v24a40 40 0 0 0 0 80v24a8 8 0 0 1-8 8H40a8 8 0 0 1-8-8v-24a40 40 0 0 0 0-80z" /><path d="M104 56v144" stroke-dasharray="16 16" /></svg>
      {app.space.ticket}
    </button>
  {:else}
    <button class="ticket add" title="Set the ticket of this task (Jira key or URL): used in the commits" onclick={() => ops.askTicket()}>+ ticket</button>
  {/if}
  {#if app.view === "code"}<button class="filesbtn" aria-pressed={app.filesOpen} title="Show or hide the files (B)" onclick={() => app.dispatch({ type: "toggle-files" })}>
    <svg width="14" height="14" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="20" stroke-linejoin="round" aria-hidden="true"><path d="M32 72a16 16 0 0 1 16-16h48l24 24h88a16 16 0 0 1 16 16v96a16 16 0 0 1-16 16H48a16 16 0 0 1-16-16z"></path></svg>
    Files <kbd>B</kbd>
  </button>{/if}
  <div class="chips">
    {#each app.space.repos as r (r.name)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span class="chip" class:old={r.worktree !== r.source} style:--rc={colorOfRepo(app.space, r.name)} oncontextmenu={(e) => openAtEvent(e, repoChipMenu(r.name), r.name)}>
        <button class="chipb" title={`${r.worktree}, on ${repoBranch(app.space, r.name)}${r.worktree !== r.source ? `\nStill in a Vela worktree: right click, "Work in my clone"` : ""}`} onclick={() => { if (!app.filesOpen) app.dispatch({ type: "toggle-files" }); }}><b>{r.name}</b>{#if split}<span class="rb mono">{repoBranch(app.space, r.name)}</span>{/if}</button>
        {#if app.space.repos.length > 1}
          <button class="rm" aria-label={`Remove ${r.name} from this space`} title="Remove from this space (the repo itself is not touched)" onclick={() => app.dispatch({ type: "remove-repo", repo: r.name })}>×</button>
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
  .rb {
    font-size: 11px;
    font-weight: 400;
    color: var(--muted);
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ticket {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 9px;
    border-radius: 8px;
    font-size: 12px;
    color: var(--fg);
    background: color-mix(in srgb, var(--info) 14%, var(--panel));
  }
  .ticket:hover {
    background: color-mix(in srgb, var(--info) 22%, var(--panel));
  }
  .ticket.add {
    background: transparent;
    color: var(--faint);
  }
  .ticket.add:hover {
    background: var(--panel);
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
  .branch {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    border-radius: 8px;
    font-size: 12px;
    color: var(--muted);
    background: var(--panel);
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .branch:hover {
    color: var(--fg);
    background: var(--hover);
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--rc) 12%, var(--panel));
    box-shadow: inset 2px 0 0 color-mix(in srgb, var(--rc) 80%, transparent);
    font-size: 12px;
    color: var(--muted);
  }
  .chip b {
    color: var(--fg);
    font-weight: 600;
  }
  .chip.old {
    outline: 1px dashed var(--faint);
    outline-offset: 1px;
  }
</style>
