<script lang="ts">
  import { app } from "../lib/app.svelte";
  import { agentStatusColor, plural, roleLabel, toolLabel } from "../lib/format";
  import { isRunning, logLine, totalUsage, usageLine } from "../lib/agents";
  import type { AgentLogEntry } from "../lib/types";
  import Kbd from "./Kbd.svelte";

  const q = $derived(app.sd.question);
  const agents = $derived(app.sd.agents);
  const total = $derived(usageLine(totalUsage(agents)));
  const wt = (w: [string, string][]) => (w.length ? `${w[0][0]} · ${w[0][1]}` : "read only");

  let reply = $state("");
  /** Logs that were opened, by agent id. */
  let logs = $state<Record<string, AgentLogEntry[] | null>>({});

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
</script>

<div class="ag">
  {#if q}
    <div class="ask">
      <small>{roleLabel(q.role)} · {toolLabel(q.tool)} asks</small>
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
        Press <Kbd k="@" /> or use the button below to ask an agent for something. It works in its own worktree and
        proposes changes you accept or reject.
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
  {:else if total}
    <div class="total" title="Tokens and cost of all agents of this space">{plural(agents.length, "agent", "agents")} · {total}</div>
  {/if}

  {#each agents as a (a.id)}
    {@const c = agentStatusColor(a.status)}
    {@const use = usageLine(a.usage)}
    <div class="agent">
      <span class="dot" class:pulse={a.status === "working"} style:--c={c}></span>
      <span class="who"
        >{roleLabel(a.role)}<span>{toolLabel(a.tool)}{a.model ? ` · ${a.model}` : ""}{a.tier ? ` · ${a.tier}` : ""}</span></span
      >
      <span class="stt" style:--c={c}>{a.status}</span>
      <span class="txt">{a.summary || a.prompt || ""}</span>
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
      <span class="wt">{wt(a.worktrees)}{use ? ` · ${use}` : ""}</span>
      <span class="actions">
        {#if isRunning(a)}
          <button class="btn" onclick={() => app.cancelAgent(a.id)}>Cancel</button>
        {/if}
        <button class="btn" aria-expanded={a.id in logs} onclick={() => toggleLog(a.id)}>
          {a.id in logs ? "Hide log" : "View log"}
        </button>
      </span>
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
    </div>
  {/each}
  <button class="btn ask-btn" onclick={() => app.openComposer()}>Ask an agent <Kbd k="@" /></button>
</div>

<style>
  .ag {
    max-width: 820px;
    margin: 0 auto;
    padding: 20px 20px 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
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
  }
  .ask p {
    margin: 0;
    font-size: 15px;
    line-height: 22px;
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
    border: 0;
    outline: none;
    background: var(--panel);
    color: var(--fg);
    font: inherit;
    font-size: 13px;
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
  .total {
    font-size: 12px;
    color: var(--faint);
    padding: 0 4px;
  }
  .agent {
    background: var(--raised);
    border-radius: 14px;
    padding: 14px;
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 4px 12px;
    align-items: center;
  }
  .who {
    font-weight: 600;
  }
  .who span {
    font-weight: 400;
    color: var(--faint);
    font-size: 12px;
    margin-left: 6px;
  }
  .stt {
    font-size: 12px;
    color: var(--c);
  }
  .txt {
    grid-column: 2/4;
    font-size: 13px;
    color: var(--fg);
  }
  .stream {
    grid-column: 2/4;
    margin: 0;
    max-height: 120px;
    overflow: auto;
    white-space: pre-wrap;
    font: inherit;
    font-size: 13px;
    line-height: 19px;
    color: var(--muted);
  }
  .plan {
    grid-column: 2/4;
    margin: 0;
    padding-left: 18px;
    font-size: 13px;
    line-height: 20px;
    color: var(--muted);
  }
  .wt {
    grid-column: 2/4;
    font-family: var(--code);
    font-size: 12px;
    color: var(--faint);
  }
  .actions {
    grid-column: 2/4;
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
  .log {
    grid-column: 1/4;
    margin-top: 6px;
    max-height: 260px;
    overflow: auto;
    background: var(--panel);
    border-radius: 10px;
    padding: 10px 12px;
    font-family: var(--code);
    font-size: 12px;
    line-height: 18px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .line {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .line.you {
    color: var(--space);
  }
  .line.tool {
    color: var(--faint);
  }
  .line.end {
    color: var(--muted);
    font-weight: 600;
  }
  .faint {
    color: var(--faint);
  }
  .ask-btn {
    align-self: flex-start;
  }
</style>
