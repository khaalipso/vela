<script lang="ts">
  // The conversation with one agent: your requests, its full answers (Markdown), the tools
  // it used grouped between answers, its plan, its questions and the end of each run.
  // Updates live; the field at the bottom answers it or gives it more work.
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import { tick } from "svelte";
  import { chatItems, isRunning, usageLine, type ChatItem } from "../lib/agents";
  import { app } from "../lib/app.svelte";
  import { agentStatusColor, ROLE_COLORS, roleLabel, toolLabel } from "../lib/format";
  import type { Agent, AgentLogEntry } from "../lib/types";
  import Kbd from "./Kbd.svelte";

  let { agent }: { agent: Agent } = $props();

  let log = $state<AgentLogEntry[] | null>(null);
  let text = $state("");
  let scroller: HTMLDivElement | undefined = $state();
  let input: HTMLTextAreaElement | undefined = $state();
  let openTools = $state<Record<number, boolean>>({});
  /** Follow the bottom while new things arrive, unless you scrolled up. */
  let stick = true;
  let loadSeq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let now = $state(Date.now());

  const items = $derived(log ? chatItems(log) : []);
  const running = $derived(isRunning(agent));
  const waiting = $derived(agent.status === "waiting");
  const q = $derived(waiting && app.sd.question?.agentId === agent.id ? app.sd.question : null);
  const canSend = $derived(!running && (waiting || !!agent.session));
  const use = $derived(usageLine(agent.usage));

  const md = (t: string) => DOMPurify.sanitize(marked.parse(t, { gfm: true, breaks: false, async: false }) as string);

  async function load(id: string) {
    const seq = ++loadSeq;
    try {
      const l = await app.backend.agentLog(app.space.id, id);
      if (seq !== loadSeq) return;
      log = l;
    } catch {
      if (seq === loadSeq) log = [];
    }
    await tick();
    if (stick) bottom();
  }

  function bottom() {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function onScroll() {
    if (!scroller) return;
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  }

  // A new agent: load its log from the top.
  $effect(() => {
    const id = agent.id;
    log = null;
    stick = true;
    openTools = {};
    void load(id);
  });

  // Its events, live: reload the log (cheap, it is a file) a moment after a burst.
  $effect(() => {
    const id = agent.id;
    const off = app.onAgentNotice((n) => {
      if (n.agentId !== id || n.spaceId !== app.space.id) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(id), 120);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  });

  $effect(() => {
    if (!running) return;
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  function took(): string {
    const start = agent.started ? Date.parse(agent.started) : NaN;
    if (!start) return "";
    const end = agent.finished ? Date.parse(agent.finished) : now;
    const s = Math.max(0, Math.round((end - start) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  async function send() {
    const t = text.trim();
    if (!t || !canSend) return;
    text = "";
    stick = true;
    if (q) await app.reply(t);
    else await app.followUp(agent.id, t);
    await load(agent.id);
  }

  async function answer(option: string) {
    stick = true;
    await app.reply(option);
    await load(agent.id);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  function toolsLabel(it: Extract<ChatItem, { kind: "tools" }>): string {
    const n = it.calls.length;
    const names = [...new Set(it.calls.map((c) => c.name))].slice(0, 4).join(", ");
    const files = it.files.length ? ` · edited ${it.files.length} file${it.files.length > 1 ? "s" : ""}` : "";
    return `${n} tool call${n > 1 ? "s" : ""} (${names})${files}`;
  }

  export function focus() {
    input?.focus();
  }
</script>

<section class="chat" aria-label="Conversation with {agent.id}" style:--rc={ROLE_COLORS[agent.role]}>
  <header class="ch">
    <span class="dot" class:pulse={running} style:--c={agentStatusColor(agent.status)}></span>
    <b>{roleLabel(agent.role)}</b>
    <span class="tags">
      <span class="tag">{toolLabel(agent.tool)}</span>
      {#if agent.model}<span class="tag">{agent.model}</span>{/if}
      {#if agent.tier}<span class="tag">{agent.tier}</span>{/if}
    </span>
    <span class="stt" style:--c={agentStatusColor(agent.status)}>{agent.status}</span>
    <span class="meta">{took()}{use ? ` · ${use}` : ""}</span>
    <span class="acts">
      {#if running}
        <button class="btn" onclick={() => app.cancelAgent(agent.id)}>Cancel</button>
      {:else}
        <button class="btn ghost" onclick={() => app.rerun(agent)} title="Open the composer with this request">Edit and rerun</button>
      {/if}
      {#if agent.worktrees.length && app.pending.some((p) => p.hunk.origin.type === "agent" && p.hunk.origin.agent === agent.id)}
        <button class="btn ghost" onclick={() => app.setView("review")}>Review its changes <Kbd k="2" /></button>
      {/if}
    </span>
  </header>

  <div class="scroll" bind:this={scroller} onscroll={onScroll} aria-live="polite">
    {#if log === null}
      <div class="skel"></div>
      <div class="skel short"></div>
    {:else if !items.length}
      <p class="faint">Nothing yet.</p>
    {/if}
    {#each items as it, i (i)}
      {#if it.kind === "you"}
        <div class="you"><div class="bubble">{it.text}</div></div>
      {:else if it.kind === "agent"}
        <div class="agent-msg md">{@html md(it.text)}</div>
      {:else if it.kind === "tools"}
        <div class="tools">
          <button class="tsum" aria-expanded={!!openTools[i]} onclick={() => (openTools = { ...openTools, [i]: !openTools[i] })}>
            <span class="chev" class:open={openTools[i]}>▸</span>
            {toolsLabel(it)}
          </button>
          {#if openTools[i]}
            <ul>
              {#each it.calls as c, j (j)}
                <li><b>{c.name}</b> <span class="mono">{c.summary}</span></li>
              {/each}
              {#each it.files as f (f)}
                <li class="file"><b>edited</b> <span class="mono">{f}</span></li>
              {/each}
            </ul>
          {/if}
        </div>
      {:else if it.kind === "plan"}
        <div class="plan">
          <small>Plan</small>
          <ol>
            {#each it.steps as st, j (j)}<li>{st}</li>{/each}
          </ol>
        </div>
      {:else if it.kind === "question"}
        <div class="question">
          <small>Asks you</small>
          <p>{it.text}</p>
          {#if q && i === items.findLastIndex((x) => x.kind === "question")}
            <div class="opts">
              {#each q.options?.length ? q.options : [q.yes, q.no] as o, j (j)}
                <button class="btn" class:p={j === 0} onclick={() => answer(o)}>{o}</button>
              {/each}
            </div>
          {/if}
        </div>
      {:else if it.kind === "end"}
        <div class="end" class:bad={!it.ok}><span>{it.text}</span></div>
      {/if}
    {/each}
    {#if q && !items.some((x) => x.kind === "question")}
      <div class="question">
        <small>Asks you</small>
        <p>{q.text}</p>
        <div class="opts">
          {#each q.options?.length ? q.options : [q.yes, q.no] as o, j (j)}
            <button class="btn" class:p={j === 0} onclick={() => answer(o)}>{o}</button>
          {/each}
        </div>
      </div>
    {/if}
    {#if running}
      <div class="typing"><span></span><span></span><span></span> working</div>
    {/if}
  </div>

  <form
    class="say"
    onsubmit={(e) => {
      e.preventDefault();
      void send();
    }}
  >
    <textarea
      bind:this={input}
      bind:value={text}
      rows="2"
      disabled={!canSend}
      onkeydown={onKey}
      aria-label="Message to {agent.id}"
      placeholder={running
        ? "Working… you can write once it stops, or cancel it"
        : q
          ? "Answer the question in words"
          : agent.session
            ? "Give it more work: same session, same worktree (Enter to send, Shift Enter for a new line)"
            : "This agent cannot be resumed: edit and rerun instead"}
    ></textarea>
    <button class="btn p" type="submit" disabled={!canSend || !text.trim()}>{q ? "Answer" : "Send"}</button>
  </form>
</section>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background: var(--raised);
    border-radius: 14px;
    overflow: hidden;
  }
  .ch {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line);
    box-shadow: inset 3px 0 0 var(--rc);
  }
  .tags {
    display: flex;
    gap: 4px;
  }
  .tag {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 9999px;
    background: var(--hover);
    color: var(--muted);
  }
  .stt {
    font-size: 12px;
    font-weight: 600;
    color: var(--c);
  }
  .meta {
    font-size: 12px;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }
  .acts {
    margin-left: auto;
    display: flex;
    gap: 6px;
  }
  .ghost {
    background: transparent;
  }
  .ghost:hover {
    background: var(--hover);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .you {
    display: flex;
    justify-content: flex-end;
  }
  .bubble {
    max-width: 80%;
    background: color-mix(in srgb, var(--space) 16%, var(--panel));
    border-radius: 14px 14px 4px 14px;
    padding: 8px 12px;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .agent-msg {
    font-size: 13.5px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .md :global(p) {
    margin: 0 0 8px;
  }
  .md :global(p:last-child) {
    margin-bottom: 0;
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3) {
    font-size: 14px;
    margin: 12px 0 6px;
  }
  .md :global(ul),
  .md :global(ol) {
    margin: 4px 0 8px;
    padding-left: 22px;
  }
  .md :global(code) {
    font-family: var(--code);
    font-size: 12px;
    background: var(--panel);
    border-radius: 4px;
    padding: 1px 4px;
  }
  .md :global(pre) {
    background: var(--panel);
    border-radius: 10px;
    padding: 10px 12px;
    overflow-x: auto;
  }
  .md :global(pre code) {
    background: none;
    padding: 0;
  }
  .md :global(table) {
    border-collapse: collapse;
    font-size: 12.5px;
  }
  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--line);
    padding: 4px 8px;
  }
  .md :global(a) {
    color: var(--info);
  }
  .md :global(blockquote) {
    margin: 0;
    padding-left: 10px;
    border-left: 2px solid var(--line);
    color: var(--muted);
  }
  .tools {
    font-size: 12px;
    color: var(--faint);
  }
  .tsum {
    color: var(--faint);
    display: inline-flex;
    gap: 6px;
    align-items: center;
    padding: 2px 6px;
    border-radius: 6px;
    text-align: left;
  }
  .tsum:hover {
    background: var(--hover);
    color: var(--muted);
  }
  .chev {
    display: inline-block;
    transition: transform 150ms var(--ease);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .tools ul {
    list-style: none;
    margin: 4px 0 0 18px;
    padding: 0 0 0 10px;
    border-left: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tools li b {
    color: var(--muted);
    font-weight: 600;
  }
  .tools li.file b {
    color: var(--add);
  }
  .plan,
  .question {
    background: var(--panel);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 13px;
  }
  .plan small,
  .question small {
    font-size: 11px;
    font-weight: 600;
    color: var(--faint);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .plan ol {
    margin: 4px 0 0;
    padding-left: 20px;
    color: var(--muted);
  }
  .question {
    box-shadow: 0 0 0 1px var(--space);
  }
  .question p {
    margin: 4px 0 8px;
    white-space: pre-wrap;
  }
  .opts {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .end {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11px;
    color: var(--add);
  }
  .end.bad {
    color: var(--del);
  }
  .end::before,
  .end::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  .end span {
    max-width: 70%;
    text-align: center;
  }
  .typing {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--faint);
  }
  .typing span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--rc);
    animation: blink 1.2s infinite;
  }
  .typing span:nth-child(2) {
    animation-delay: 0.2s;
  }
  .typing span:nth-child(3) {
    animation-delay: 0.4s;
    margin-right: 4px;
  }
  @keyframes blink {
    50% {
      opacity: 0.2;
    }
  }
  .skel {
    height: 60px;
    border-radius: 10px;
    background: linear-gradient(90deg, var(--panel), var(--hover), var(--panel));
    background-size: 200% 100%;
    animation: shimmer 1.2s linear infinite;
  }
  .skel.short {
    height: 30px;
    width: 60%;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
  .faint {
    color: var(--faint);
  }
  .say {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    padding: 10px 12px;
    border-top: 1px solid var(--line);
  }
  .say textarea {
    flex: 1;
    min-width: 0;
    resize: none;
    max-height: 160px;
    background: var(--panel);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 8px 10px;
    font: inherit;
    font-size: 13px;
    line-height: 1.45;
    outline: none;
  }
  .say textarea:focus {
    border-color: var(--space);
  }
  .say textarea:disabled {
    opacity: 0.6;
  }
</style>
