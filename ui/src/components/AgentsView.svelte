<script lang="ts">
  // The agents of the space: the list on the left (at work first), the conversation with the
  // selected one on the right. J / K or a click picks an agent.
  import { app } from "../lib/app.svelte";
  import { agentName, plural, ROLE_COLORS, roleLabel, tagColor, toolLabel } from "../lib/format";
  import { unread } from "../lib/unread.svelte";
  import { isRunning, QUIET_WARN_MS, quietFor, shortDuration, totalUsage, usageLine } from "../lib/agents";
  import type { Agent } from "../lib/types";
  import AgentChat from "./AgentChat.svelte";
  import Kbd from "./Kbd.svelte";

  const agents = $derived(app.branchAgents);
  const elsewhere = $derived(app.sd.agents.filter((a) => !app.onThisBranch(a)).length);
  const total = $derived(usageLine(totalUsage(agents)));
  const shown = $derived(app.agentList);
  const active = $derived(shown.filter((a) => a.status === "working" || a.status === "waiting"));
  const finished = $derived(shown.filter((a) => a.status !== "working" && a.status !== "waiting"));
  const sel = $derived(app.selectedAgent);
  let shownDone = $state(12);
  let search: HTMLInputElement | undefined = $state();
  /** The labels of the space, most used first: one click filters the list. */
  const labels = $derived.by(() => {
    const n = new Map<string, number>();
    for (const a of agents) for (const l of a.labels ?? []) n.set(l, (n.get(l) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([l]) => l);
  });
  // Seen on screen = read: the open conversation, and the first load.
  $effect(() => unread.seed(agents));
  $effect(() => {
    if (sel) unread.markRead(sel);
  });
  /** Blue: at work. Orange: needs you. Green: an answer you have not read. Nothing otherwise. */
  function mark(a: Agent): { color: string; title: string; pulse: boolean } | null {
    if (a.status === "working") return { color: "var(--info)", title: "At work", pulse: true };
    if (a.status === "waiting" || a.status === "failed" || a.status === "interrupted")
      return { color: "var(--warn)", title: a.status === "waiting" ? "Needs your answer" : "Needs a look", pulse: false };
    if (unread.isUnread(a)) return { color: "var(--add)", title: "Unread answer", pulse: false };
    return null;
  }
  let now = $state(Date.now());
  $effect(() => {
    if (!active.some(isRunning)) return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(t);
  });
  function when(a: Agent): { text: string; warn: boolean } {
    if (a.status === "waiting") return { text: "asks", warn: false };
    if (!isRunning(a)) return { text: ago(a), warn: false };
    const q = quietFor(a, now);
    return q >= QUIET_WARN_MS ? { text: `quiet ${shortDuration(q)}`, warn: true } : { text: "working", warn: false };
  }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (app.agentQuery) app.agentQuery = "";
      else search?.blur();
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === "Enter" && shown[0]) {
      app.selectAgent(shown[0].id);
      search?.blur();
    }
  }

  function ago(a: Agent): string {
    const t = Date.parse(a.finished ?? a.started ?? "");
    if (!t) return "";
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  }
</script>

<div class="ag">
  <header class="bar">
    <h3>Agents</h3>
    <span class="total" title="Tokens and cost of all agents of this space">
      {plural(agents.length, "agent", "agents")}{total ? ` · ${total}` : ""}
    </span>
    <button class="btn ghost" onclick={() => app.dispatch({ type: "open-prompts" })} title="Edit the brief each role gets">Prompts</button>
    <button class="btn ghost" onclick={() => app.dispatch({ type: "open-settings" })} title="Model and reasoning effort per tier">Tiers</button>
    {#if app.upNext.kind.type !== "nothing"}
      <button class="next" onclick={() => app.upNextGo()} title="Up next">
        <span class="nd"></span><b>{app.upNext.title}</b><Kbd k={app.upNext.key} />
      </button>
    {/if}
    <button class="btn p ask-btn" onclick={() => app.openComposer()}>Ask an agent <Kbd k="Ctrl K" /></button>
  </header>

  {#if agents.length === 0}
    <div class="empty">
      <b>No agents yet</b>
      <p>
        Press <Kbd k="Ctrl K" /> to ask an agent for something. Developers, testers and debuggers work in their own
        worktree and propose changes you accept or reject in the Review; reviewers, planners, product and security
        only read and answer here.
      </p>
      <ul class="harnesses" aria-label="Detected harnesses">
        {#each app.harnesses as h (h.name)}
          <li class:off={!h.available}>
            <span class="dot" style:--c={h.available ? "var(--add)" : "var(--faint)"}></span>
            <span class="who">{h.label}</span>
            <span class="ver">{h.available ? (h.version ?? "installed") : "not installed"}</span>
          </li>
        {:else}
          <li class="off">No harness detected</li>
        {/each}
      </ul>
    </div>
  {:else}
    <div class="split">
      <nav class="list" aria-label="Agents of the space">
        <div class="find">
          <input
            class="field small"
            type="search"
            bind:this={search}
            bind:value={app.agentQuery}
            onkeydown={onSearchKey}
            placeholder="Search: label, request, session"
            aria-label="Search the conversations"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        {#if labels.length}
          <div class="labels" aria-label="Labels">
            {#each labels as l (l)}
              <button class="lb" style:--c={tagColor(l)} class:on={app.agentQuery.trim().toLowerCase() === l.toLowerCase()} onclick={() => (app.agentQuery = app.agentQuery.trim().toLowerCase() === l.toLowerCase() ? "" : l)}>{l}</button>
            {/each}
          </div>
        {/if}
        {#if !shown.length}
          <p class="none">No conversation matches “{app.agentQuery}”. <button class="btn ghost" onclick={() => (app.agentQuery = "")}>Clear</button></p>
        {/if}
        {#if elsewhere}
          <button class="btn ghost more" onclick={() => (app.allBranches = !app.allBranches)}>
            {app.allBranches ? "Only this branch" : `${plural(elsewhere, "agent", "agents")} on other branches`}
          </button>
        {/if}
        {#if active.length}<h4>At work <span>{active.length}</span></h4>{/if}
        {#each active as a (a.id)}{@render item(a)}{/each}
        {#if finished.length}<h4>Finished <span>{finished.length}</span></h4>{/if}
        {#each finished.slice(0, shownDone) as a (a.id)}{@render item(a)}{/each}
        {#if finished.length > shownDone}
          <button class="btn ghost more" onclick={() => (shownDone += 20)}>Show more</button>
        {/if}
      </nav>
      {#if sel}
        {#key sel.id}<AgentChat agent={sel} />{/key}
      {/if}
    </div>
  {/if}
</div>

{#snippet item(a: Agent)}
  {@const w = when(a)}
  {@const m = mark(a)}
  <button class="item" class:on={sel?.id === a.id} aria-current={sel?.id === a.id} data-agent={a.id} style:--rc={ROLE_COLORS[a.role]} onclick={() => app.selectAgent(a.id)}>
    <span class="mk">{#if m}<span class="dot" class:pulse={m.pulse} style:--c={m.color} title={m.title}></span>{/if}</span>
    <span class="body">
      <span class="top"
        ><b>{agentName(a.id)}</b><span class="role">{roleLabel(a.role)}</span><span class="tool">{toolLabel(a.tool)}</span>{#if a.tier}<span class="tier" data-tier={a.tier}>{a.tier}</span>{/if}<span class="when" class:warn={w.warn} title={w.warn ? "No event for a while: it may be stuck" : undefined}
          >{w.text}</span
        ></span
      >
      <span class="sum" class:ttl={!!a.title}>{a.title || a.prompt || a.summary}</span>
      {#if isRunning(a) && a.activity}<span class="act">{a.activity}</span>{/if}
      {#if a.labels?.length}
        <span class="tags">{#each a.labels as l (l)}<span class="lt" style:--c={tagColor(l)}>{l}</span>{/each}</span>
      {/if}
    </span>
  </button>
{/snippet}

<style>
  .ag {
    height: 100%;
    box-sizing: border-box;
    padding: 12px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .next {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px 5px 12px;
    border-radius: 9999px;
    background: var(--hover);
    font-size: 12.5px;
    max-width: 40ch;
  }
  .next:hover {
    background: var(--line);
  }
  .next b {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nd {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--space);
  }
  .tier {
    font-size: 10.5px;
    font-weight: 700;
    padding: 0 6px;
    border-radius: 9999px;
    color: var(--faint);
    background: var(--hover);
    font-weight: 500;
  }
  .mk {
    flex: none;
    width: 8px;
    margin-top: 6px;
  }
  .role {
    font-size: 12px;
    color: var(--muted);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .bar h3 {
    margin: 0;
    font-size: 16px;
  }
  .total {
    font-size: 12px;
    color: var(--faint);
    margin-right: auto;
  }
  .ghost {
    background: transparent;
  }
  .ghost:hover {
    background: var(--hover);
  }
  .split {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    gap: 12px;
  }
  .list {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
  }
  h4 {
    margin: 8px 6px 4px;
    font-size: 11px;
    color: var(--faint);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    display: flex;
    gap: 6px;
  }
  h4 span {
    font-weight: 400;
  }
  .item {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    text-align: left;
    padding: 8px 10px;
    border-radius: 10px;
    width: 100%;
  }
  .item:hover {
    background: var(--hover);
  }
  .item.on {
    background: color-mix(in srgb, var(--rc) 14%, var(--hover));
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .top {
    display: flex;
    gap: 6px;
    align-items: baseline;
    font-size: 13px;
  }
  .tool {
    font-size: 11px;
    color: var(--faint);
  }
  .when {
    margin-left: auto;
    font-size: 11px;
    color: var(--faint);
  }
  .sum {
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sum.ttl {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--fg);
  }
  .more {
    align-self: center;
    margin-top: 6px;
  }
  .find {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg);
    padding-bottom: 4px;
  }
  .find input {
    width: 100%;
    box-sizing: border-box;
  }
  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 2px 2px 4px;
  }
  .lb {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 9999px;
    background: var(--hover);
    color: var(--muted);
  }
  .lb {
    color: color-mix(in srgb, var(--c) 70%, var(--muted));
  }
  .lb:hover {
    color: var(--fg);
  }
  .lb.on {
    background: color-mix(in srgb, var(--space) 22%, transparent);
    color: var(--fg);
  }
  .lb:focus-visible {
    outline: 2px solid var(--space);
  }
  .none {
    font-size: 12px;
    color: var(--faint);
    margin: 8px 6px;
  }
  .when.warn {
    color: var(--warn);
    font-weight: 600;
  }
  .act {
    font-size: 11.5px;
    color: var(--faint);
    font-family: var(--code);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-top: 2px;
  }
  .lt {
    font-size: 10.5px;
    padding: 0 6px;
    border-radius: 9999px;
    color: var(--c);
    background: color-mix(in srgb, var(--c) 13%, transparent);
  }
  .empty {
    background: var(--raised);
    border-radius: 14px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 720px;
  }
  .empty p {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 20px;
  }
  .harnesses {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .harnesses li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }
  .harnesses li.off {
    color: var(--faint);
  }
  .ver {
    margin-left: auto;
    font-family: var(--code);
    font-size: 12px;
    color: var(--faint);
  }
  @media (max-width: 860px) {
    .split {
      grid-template-columns: 1fr;
    }
    .list {
      max-height: 200px;
    }
  }
</style>
