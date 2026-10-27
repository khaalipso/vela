<script lang="ts">
  // The agents of the space: the list on the left (at work first), the conversation with the
  // selected one on the right. J / K or a click picks an agent.
  import { app } from "../lib/app.svelte";
  import { agentStatusColor, plural, ROLE_COLORS, roleLabel, toolLabel } from "../lib/format";
  import { isRunning, totalUsage, usageLine } from "../lib/agents";
  import type { Agent } from "../lib/types";
  import AgentChat from "./AgentChat.svelte";
  import Kbd from "./Kbd.svelte";

  const agents = $derived(app.sd.agents);
  const total = $derived(usageLine(totalUsage(agents)));
  const active = $derived(agents.filter((a) => a.status === "working" || a.status === "waiting"));
  const finished = $derived(agents.filter((a) => a.status !== "working" && a.status !== "waiting"));
  const sel = $derived(app.selectedAgent);
  let shownDone = $state(12);

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
  <button class="item" class:on={sel?.id === a.id} aria-current={sel?.id === a.id} data-agent={a.id} style:--rc={ROLE_COLORS[a.role]} onclick={() => app.selectAgent(a.id)}>
    <span class="dot" class:pulse={a.status === "working"} style:--c={agentStatusColor(a.status)}></span>
    <span class="body">
      <span class="top"
        ><b>{roleLabel(a.role)}</b><span class="tool">{toolLabel(a.tool)}{a.tier ? ` · ${a.tier}` : ""}</span><span class="when"
          >{a.status === "waiting" ? "asks" : isRunning(a) ? "working" : ago(a)}</span
        ></span
      >
      <span class="sum">{a.prompt || a.summary}</span>
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
    margin-bottom: -96px;
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
    padding-bottom: 84px;
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
  .item .dot {
    margin-top: 6px;
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
  .more {
    align-self: center;
    margin-top: 6px;
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
