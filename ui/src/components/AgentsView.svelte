<script lang="ts">
  // The agents of the space: a toolbar (prompts, tiers, ask), the question waiting for you,
  // the agents at work, then the finished ones. Each card shows the request, what the agent
  // says and plans, and takes a follow up or an edited rerun.
  import { tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { agentStatusColor, plural, ROLE_COLORS, roleLabel, toolLabel } from "../lib/format";
  import { isRunning, logLine, totalUsage, usageLine } from "../lib/agents";
  import type { Agent, AgentLogEntry } from "../lib/types";
  import Kbd from "./Kbd.svelte";

  const q = $derived(app.sd.question);
  const agents = $derived(app.sd.agents);
  const total = $derived(usageLine(totalUsage(agents)));
  const active = $derived(agents.filter((a) => a.status === "working" || a.status === "waiting"));
  const finished = $derived(agents.filter((a) => a.status !== "working" && a.status !== "waiting"));
  const wt = (w: [string, string][]) => (w.length ? `${w[0][0]} · ${w[0][1].split("/").slice(-3).join("/")}` : "read only");

  let reply = $state("");
  /** Logs that were opened, by agent id. */
  let logs = $state<Record<string, AgentLogEntry[] | null>>({});
  /** Requests shown in full, by agent id. */
  let openPrompt = $state<Record<string, boolean>>({});
  /** The follow up field that is open, and its text. */
  let followFor = $state<string | null>(null);
  let followText = $state("");
  let followInput: HTMLInputElement | undefined = $state();
  /** How many finished agents are shown (the rest behind "Show more"). */
  let shownDone = $state(6);
  let now = $state(Date.now());

  // The clock of the running agents ticks once a second, only while some run.
  $effect(() => {
    if (!active.length) return;
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  function elapsed(a: Agent): string {
    const start = a.started ? Date.parse(a.started) : NaN;
    if (!start) return "";
    const end = a.finished ? Date.parse(a.finished) : now;
    const s = Math.max(0, Math.round((end - start) / 1000));
    const d = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return isRunning(a) ? d : `took ${d}`;
  }

  async function toggleLog(id: string) {
    if (id in logs) {
      const { [id]: _gone, ...rest } = logs;
      logs = rest;
      return;
    }
    logs = { ...logs, [id]: null };
    try {
      logs = { ...logs, [id]: await app.backend.agentLog(app.space.id, id) };
    } catch {
      logs = { ...logs, [id]: [] };
    }
  }

  async function sendReply() {
    const t = reply;
    reply = "";
    await app.reply(t);
  }

  async function startFollow(id: string) {
    followFor = followFor === id ? null : id;
    followText = "";
    await tick();
    followInput?.focus();
  }

  async function sendFollow(id: string) {
    if (await app.followUp(id, followText)) {
      followFor = null;
      followText = "";
    }
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
    <button class="btn p ask-btn" onclick={() => app.openComposer()}>Ask an agent <Kbd k="@" /></button>
  </header>

  {#if q}
    <div class="ask">
      <small><span class="dot" style:--c={ROLE_COLORS[q.role]}></span>{roleLabel(q.role)} · {toolLabel(q.tool)} asks</small>
      <p>{q.text}</p>
      <div class="row">
        <button class="btn p" onclick={() => app.answer(true)}>{q.yes} <Kbd k="Y" /></button>
        <button class="btn" onclick={() => app.answer(false)}>{q.no} <Kbd k="N" /></button>
        {#each (q.options ?? []).slice(2) as o (o)}
          <button class="btn" onclick={() => app.reply(o)}>{o}</button>
        {/each}
      </div>
      <form
        class="reply"
        onsubmit={(e) => {
          e.preventDefault();
          void sendReply();
        }}
      >
        <input bind:value={reply} placeholder="Answer in words" aria-label="Answer in words" />
        <button class="btn" type="submit" disabled={!reply.trim()}>Send</button>
      </form>
    </div>
  {/if}

  {#if agents.length === 0}
    <div class="empty">
      <b>No agents yet</b>
      <p>
        Press <Kbd k="@" /> to ask an agent for something. It works in its own worktree and proposes changes you accept or
        reject in the Review.
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
  {/if}

  {#if active.length}<h4 class="sec">At work <span>{active.length}</span></h4>{/if}
  {#each active as a (a.id)}{@render card(a)}{/each}

  {#if finished.length}<h4 class="sec">Finished <span>{finished.length}</span></h4>{/if}
  {#each finished.slice(0, shownDone) as a (a.id)}{@render card(a)}{/each}
  {#if finished.length > shownDone}
    <button class="btn more" onclick={() => (shownDone += 10)}>Show {Math.min(10, finished.length - shownDone)} more</button>
  {/if}
</div>

{#snippet card(a: Agent)}
  {@const c = agentStatusColor(a.status)}
  {@const use = usageLine(a.usage)}
  <article class="agent" class:live={isRunning(a)} style:--rc={ROLE_COLORS[a.role]} data-agent={a.id}>
    <div class="head">
      <span class="dot" class:pulse={a.status === "working"} style:--c={c}></span>
      <b class="role">{roleLabel(a.role)}</b>
      <span class="chips" title="{toolLabel(a.tool)}{a.model ? ` · ${a.model}` : ''}{a.tier ? ` · ${a.tier}` : ''}">
        <span class="tag">{toolLabel(a.tool)}</span>
        {#if a.model}<span class="tag">{a.model}</span>{/if}
        {#if a.tier}<span class="tag">{a.tier}</span>{/if}
      </span>
      <span class="stt" style:--c={c}>{a.status}</span>
      <span class="time">{elapsed(a)}</span>
    </div>
    {#if a.prompt}
      <button class="prompt" class:full={openPrompt[a.id]} title="Show the whole request" onclick={() => (openPrompt = { ...openPrompt, [a.id]: !openPrompt[a.id] })}>
        {a.prompt}
      </button>
    {/if}
    {#if a.summary && a.summary !== a.prompt}<p class="txt">{a.summary}</p>{/if}
    {#if isRunning(a) && a.lastMessage && a.lastMessage !== a.summary}
      <pre class="stream" aria-live="polite">{a.lastMessage}</pre>
    {/if}
    {#if a.plan && a.plan.length}
      <ol class="plan" aria-label="Plan">
        {#each a.plan as step, i (i)}
          <li>{step}</li>
        {/each}
      </ol>
    {/if}
    <div class="foot">
      <span class="wt">{wt(a.worktrees)}{use ? ` · ${use}` : ""}</span>
      <span class="actions">
        {#if isRunning(a)}
          <button class="btn" onclick={() => app.cancelAgent(a.id)}>Cancel</button>
        {/if}
        <button class="btn" aria-expanded={a.id in logs} onclick={() => toggleLog(a.id)}>
          {a.id in logs ? "Hide log" : "View log"}
        </button>
      </span>
      {#if !isRunning(a)}
        <span class="more-acts">
          {#if a.session}
            <button class="btn ghost" aria-expanded={followFor === a.id} onclick={() => startFollow(a.id)}>Follow up</button>
          {/if}
          <button class="btn ghost" onclick={() => app.rerun(a)}>Edit and rerun</button>
        </span>
      {/if}
    </div>
    {#if followFor === a.id}
      <form
        class="reply"
        onsubmit={(e) => {
          e.preventDefault();
          void sendFollow(a.id);
        }}
      >
        <input bind:this={followInput} bind:value={followText} placeholder="What next? Same session, same worktree" aria-label="Follow up for {a.id}" />
        <button class="btn p" type="submit" disabled={!followText.trim()}>Send</button>
      </form>
    {/if}
    {#if a.id in logs}
      <div class="log" role="log" aria-label={`Log of ${a.id}`}>
        {#if logs[a.id] === null}
          <span class="faint">Loading…</span>
        {:else if logs[a.id]?.length === 0}
          <span class="faint">Nothing logged.</span>
        {:else}
          {#each logs[a.id] ?? [] as entry, i (i)}
            {@const l = logLine(entry.event)}
            {#if l}
              <div class={`line ${l.who}`}>{l.text}</div>
            {/if}
          {/each}
        {/if}
      </div>
    {/if}
  </article>
{/snippet}

<style>
  .ag {
    max-width: 880px;
    margin: 0 auto;
    padding: 12px 20px 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--panel);
    padding: 8px 0;
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
  .sec {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--faint);
    font-weight: 600;
    display: flex;
    gap: 6px;
  }
  .sec span {
    font-weight: 400;
  }
  .ask {
    background: var(--raised);
    border-radius: 14px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 0 0 2px var(--space);
  }
  .ask small {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ask p {
    margin: 0;
    font-size: 15px;
    line-height: 22px;
    white-space: pre-wrap;
  }
  .row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .reply {
    display: flex;
    gap: 8px;
  }
  .reply input {
    flex: 1;
    min-width: 0;
    height: 32px;
    padding: 0 12px;
    border-radius: 9999px;
    border: 1px solid transparent;
    outline: none;
    background: var(--panel);
    color: var(--fg);
    font: inherit;
    font-size: 13px;
  }
  .reply input:focus {
    border-color: var(--space);
  }
  .empty {
    background: var(--raised);
    border-radius: 14px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
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
  .agent {
    background: var(--raised);
    border-radius: 14px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: inset 3px 0 0 color-mix(in srgb, var(--rc) 70%, transparent);
  }
  .agent.live {
    box-shadow:
      inset 3px 0 0 var(--rc),
      0 0 0 1px color-mix(in srgb, var(--rc) 30%, transparent);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .role {
    font-size: 14px;
  }
  .chips {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .tag {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 9999px;
    background: var(--hover);
    color: var(--muted);
  }
  .stt {
    margin-left: auto;
    font-size: 12px;
    font-weight: 600;
    color: var(--c);
  }
  .time {
    font-size: 12px;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }
  .prompt {
    text-align: left;
    font-size: 13px;
    color: var(--muted);
    border-left: 2px solid var(--line);
    padding: 2px 0 2px 10px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-wrap;
  }
  .prompt.full {
    display: block;
  }
  .txt {
    margin: 0;
    font-size: 13px;
    color: var(--fg);
    line-height: 20px;
  }
  .stream {
    margin: 0;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--panel);
    font-family: var(--code);
    font-size: 12px;
    white-space: pre-wrap;
    max-height: 160px;
    overflow: auto;
    color: var(--muted);
  }
  .plan {
    margin: 0;
    padding-left: 20px;
    font-size: 13px;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .wt {
    font-family: var(--code);
    font-size: 11px;
    color: var(--faint);
    margin-right: auto;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .actions,
  .more-acts {
    display: flex;
    gap: 6px;
  }
  .more {
    align-self: center;
  }
  .log {
    background: var(--panel);
    border-radius: 10px;
    padding: 8px 10px;
    font-family: var(--code);
    font-size: 12px;
    max-height: 280px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .line {
    white-space: pre-wrap;
    color: var(--muted);
  }
  .line.you {
    color: var(--space);
  }
  .line.tool {
    color: var(--faint);
  }
  .line.end {
    color: var(--add);
  }
  .faint {
    color: var(--faint);
  }
</style>
