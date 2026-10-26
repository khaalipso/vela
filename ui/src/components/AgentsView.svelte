<script lang="ts">
  import { app } from "../lib/app.svelte";
  import { agentStatusColor, roleLabel, toolLabel } from "../lib/format";
  import Kbd from "./Kbd.svelte";

  const q = $derived(app.sd.question);
  const wt = (w: [string, string][]) => (w.length ? `${w[0][0]} · ${w[0][1]}` : "read only");
</script>

<div class="ag">
  {#if q}
    <div class="ask">
      <small>{roleLabel(q.role)} · {toolLabel(q.tool)} asks</small>
      <p>{q.text}</p>
      <div class="row">
        <button class="btn p" onclick={() => app.answer(true)}>{q.yes} <Kbd k="Y" /></button>
        <button class="btn" onclick={() => app.answer(false)}>{q.no} <Kbd k="N" /></button>
        <button class="btn" onclick={() => app.openComposer()}>Answer in words <Kbd k="@" /></button>
      </div>
    </div>
  {/if}
  {#each app.sd.agents as a (a.id)}
    {@const c = agentStatusColor(a.status)}
    <div class="agent">
      <span class="dot" class:pulse={a.status === "working"} style:--c={c}></span>
      <span class="who">{roleLabel(a.role)}<span>{toolLabel(a.tool)}</span></span>
      <span class="stt" style:--c={c}>{a.status}</span>
      <span class="txt">{a.summary}</span>
      <span class="wt">{wt(a.worktrees)}</span>
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
  .wt {
    grid-column: 2/4;
    font-family: var(--code);
    font-size: 12px;
    color: var(--faint);
  }
  .ask-btn {
    align-self: flex-start;
  }
</style>
