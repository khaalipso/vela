<script lang="ts">
  // The conversation with one agent: your requests, its full answers (Markdown), the tools
  // it used grouped between answers, its plan, its questions and the end of each run.
  // Updates live; the field at the bottom answers it or gives it more work.
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import { tick, untrack } from "svelte";
  import { chatItems, currentActivity, handoffText, isAllowed, isPermission, isRunning, nextSteps, permissionLabel, NUDGE, QUIET_WARN_MS, quietFor, shortDuration, usageLine, type ChatItem, type WorkNote } from "../lib/agents";
  import { splitAnswer } from "../lib/answer";
  import { app } from "../lib/app.svelte";
  import { agentStatusColor, ROLE_COLORS, roleLabel, toolLabel } from "../lib/format";
  import type { Agent, AgentLogEntry } from "../lib/types";
  import Kbd from "./Kbd.svelte";
  import { writeClipboard } from "../lib/ops.svelte";

  let { agent }: { agent: Agent } = $props();

  let log = $state<AgentLogEntry[] | null>(null);
  let text = $state("");
  let scroller: HTMLDivElement | undefined = $state();
  let input: HTMLTextAreaElement | undefined = $state();
  /** Open groups of work, by their place among the groups: new events do not close them. */
  let openTools = $state<Record<number, boolean>>({});
  /** Follow the bottom while new things arrive, unless you scrolled up. */
  let stick = true;
  let loadSeq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let now = $state(Date.now());

  const items = $derived(log ? chatItems(log) : []);
  /** The place of each group of work among the groups: stable while the log grows. */
  const groupNo = $derived.by(() => {
    let n = 0;
    return items.map((it) => (it.kind === "tools" ? n++ : -1));
  });
  const agentId = $derived(agent.id);
  const running = $derived(isRunning(agent));
  const waiting = $derived(agent.status === "waiting");
  /** Work and reasoning stay folded until you open them. */
  const isOpen = (g: number) => !!openTools[g];
  const q = $derived(waiting && app.sd.question?.agentId === agent.id ? app.sd.question : null);
  const canSend = $derived(running || waiting || !!agent.session);
  const queued = $derived(app.queuedFor(agent.id));
  const use = $derived(usageLine(agent.usage));
  const activity = $derived(currentActivity(agent, log));
  const quiet = $derived(quietFor(agent, now, log?.[log.length - 1]?.ts));
  const stuck = $derived(quiet >= QUIET_WARN_MS);
  const nudged = $derived(queued.includes(NUDGE));

  async function copySession() {
    if (!agent.session) return;
    app.toast((await writeClipboard(agent.session)) ? "Copied the session id" : "Could not reach the clipboard");
  }

  /** Stop the run and send the agent a message asking where it is; it resumes in the same session. */
  async function nudge() {
    if (!agent.session) {
      await app.cancelAgent(agent.id);
      return;
    }
    if (!nudged) app.queueFor(agent.id, NUDGE);
    await app.cancelAgent(agent.id);
  }
  /** Sections the reader opened or closed, by message and section; the last answer starts open, older ones closed. */
  let sectionOpen = $state<Record<string, boolean>>({});
  const answers = $derived(items.map((it) => (it.kind === "agent" ? splitAnswer(it.text) : null)));
  /** The last answer is the one to read first: the older ones start closed. */
  const lastAnswer = $derived(items.findLastIndex((x) => x.kind === "agent"));
  /** After a finished run: who can take its answer over, one click to the composer. */
  const next = $derived(!running && !waiting && agent.status === "done" && lastAnswer >= 0 ? nextSteps(agent.role) : []);
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

  // A new agent: load its log from the top. (Its id, not the agent: that object is replaced on
  // each event, which would close the open groups.) Only the id is tracked: `load` reads
  // `app.space`, which is a new object each time the spaces are refreshed (every file event),
  // and that would empty the chat and paint the skeleton again and again.
  $effect(() => {
    const id = agentId;
    untrack(() => {
      log = null;
      stick = true;
      openTools = {};
      void load(id);
    });
  });

  // The agent moved on (a new event, another status): read its log again, groups stay open.
  let seenState = "";
  $effect(() => {
    const state = `${agent.status}|${agent.lastEvent ?? ""}|${agent.session ?? ""}`;
    if (state === seenState) return;
    const first = !seenState;
    seenState = state;
    if (!first) untrack(() => void load(agentId));
  });

  // Its events, live: reload the log (cheap, it is a file) a moment after a burst.
  $effect(() => {
    const id = agentId;
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
    if (running) {
      app.queueFor(agent.id, t);
      await tick();
      bottom();
      return;
    }
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
    const thought = it.notes.some((x) => x.kind === "thought");
    if (!n) return thought ? "Thought" : "Worked";
    return `${thought ? "Thought · " : ""}${n} tool call${n > 1 ? "s" : ""} (${names})${files}`;
  }

  export function focus() {
    input?.focus();
  }
</script>

{#snippet workNote(nt: WorkNote)}
  <li class={nt.kind}>{#if nt.kind === "thought"}<small>Thinking</small>{/if}{nt.text}</li>
{/snippet}

<section class="chat" aria-label="Conversation with {agent.id}" style:--rc={ROLE_COLORS[agent.role]}>
  <header class="ch">
    <span class="dot" class:pulse={running} style:--c={agentStatusColor(agent.status)}></span>
    <b>{roleLabel(agent.role)}</b>
    {#if agent.title}<h2 class="title" title={agent.title}>{agent.title}</h2>{/if}
    <span class="tags">
      <span class="tag">{toolLabel(agent.tool)}</span>
      {#if agent.model}<span class="tag">{agent.model}</span>{/if}
      {#if agent.tier}<span class="tag">{agent.tier}</span>{/if}
      {#each agent.labels ?? [] as l (l)}<button class="tag label" title="Show the conversations labelled {l}" onclick={() => (app.agentQuery = l)}>{l}</button>{/each}
    </span>
    {#if agent.session}
      <button class="sid mono" title={`Session ${agent.session} of ${toolLabel(agent.tool)}: click to copy`} aria-label="Copy the session id {agent.session}" onclick={copySession}>
        <span class="sk">session</span>{agent.session.length > 13 ? `${agent.session.slice(0, 8)}…` : agent.session}
      </button>
    {/if}
    <span class="stt" style:--c={agentStatusColor(agent.status)}>{agent.status}</span>
    <span class="meta">{took()}{use ? ` · ${use}` : ""}</span>
    <span class="acts">
      {#if running}
        <button class="btn" onclick={() => app.cancelAgent(agent.id)}>Cancel</button>
      {:else}
        <button class="btn ghost" onclick={() => app.rerun(agent)} title="Open the composer with this request">Edit and rerun</button>
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
        {@const ans = answers[i]}
        {#if ans}
          <article class="card agent-msg" class:old={i !== lastAnswer}>
            {#if ans.lead}<div class="lead md">{@html md(ans.lead)}</div>{/if}
            {#each ans.sections as s, j (j)}
              {@const k = `${i}:${j}`}
              {@const open = sectionOpen[k] ?? (i === lastAnswer)}
              <section class="sec" class:open>
                <button class="sh" aria-expanded={open} onclick={() => (sectionOpen = { ...sectionOpen, [k]: !open })}>
                  <span class="chev" class:open>▸</span>
                  <b>{s.title}</b>
                </button>
                {#if open}<div class="sb md">{@html md(s.body)}</div>{/if}
              </section>
            {/each}
          </article>
        {/if}
        {#if i === lastAnswer && next.length && it.kind === "agent"}
          <div class="next" role="group" aria-label="Next">
            <span class="nl">Next</span>
            {#each next as st (st.label)}
              <button class="btn" style:--rc={ROLE_COLORS[st.role]} title="Opens the composer for the {roleLabel(st.role)} with this answer in it; you edit before sending" onclick={() => app.handoff(agent, st, it.text)}>
                <span class="dot" style:--c={ROLE_COLORS[st.role]}></span>
                {st.label}<small>{roleLabel(st.role)}</small>
              </button>
            {/each}
          </div>
        {/if}
      {:else if it.kind === "tools"}
        {@const g = groupNo[i]}
        <div class="tools">
          <button class="tsum" aria-expanded={isOpen(g)} onclick={() => (openTools = { ...openTools, [g]: !isOpen(g) })}>
            <span class="chev" class:open={isOpen(g)}>▸</span>
            {toolsLabel(it)}
          </button>
          {#if isOpen(g)}
            <ul>
              {#each it.calls as c, j (j)}
                {#each it.notes.filter((x) => x.before === j) as nt, k (k)}{@render workNote(nt)}{/each}
                <li><b>{c.name}</b> <span class="mono">{c.summary}</span></li>
              {/each}
              {#each it.notes.filter((x) => x.before >= it.calls.length) as nt, k (k)}{@render workNote(nt)}{/each}
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
        {@const perm = isPermission(it.options)}
        {@const pending = !!q && i === items.findLastIndex((x) => x.kind === "question")}
        {@const verdict = perm && !pending ? (it.answer === undefined || isAllowed(it.answer) ? "allowed" : "denied") : ""}
        <div class="question" class:perm class:pending={perm && pending} class:allowed={verdict === "allowed"} class:denied={verdict === "denied"}>
          <small>{perm ? (verdict === "allowed" ? "Allowed" : verdict === "denied" ? "Denied" : "Permission") : "Asks you"}</small>
          {#if perm}<code class="cmd">{it.text}</code>{:else}<p>{it.text}</p>{/if}
          {#if pending}
            <div class="opts">
              {#each q.options?.length ? q.options : [q.yes, q.no] as o, j (j)}
                <button class="btn" class:p={j === 0} onclick={() => answer(o)}>{perm ? permissionLabel(o) : o}</button>
              {/each}
            </div>
          {/if}
        </div>
      {:else if it.kind === "applied"}
        <div class="applied" class:bad={it.conflicts.length > 0}>
          {#if it.files.length}<span>Applied to your files: <span class="mono">{it.files.join(", ")}</span></span>{/if}
          {#if it.conflicts.length}
            <span>
              {it.toYou ? "Conflicts left in your files, to resolve in the Review:" : "Conflicts with your edits, the agent resolves them:"}
              <span class="mono">{it.conflicts.join(", ")}</span>
            </span>
          {/if}
        </div>
      {:else if it.kind === "end"}
        <div class="end" class:bad={!it.ok}><span>{it.text}</span></div>
      {/if}
    {/each}
    {#if q && !items.some((x) => x.kind === "question")}
      {@const perm = isPermission(q.options ?? [])}
      <div class="question" class:perm class:pending={perm}>
        <small>{perm ? "Permission" : "Asks you"}</small>
        {#if perm}<code class="cmd">{q.text}</code>{:else}<p>{q.text}</p>{/if}
        <div class="opts">
          {#each q.options?.length ? q.options : [q.yes, q.no] as o, j (j)}
            <button class="btn" class:p={j === 0} onclick={() => answer(o)}>{perm ? permissionLabel(o) : o}</button>
          {/each}
        </div>
      </div>
    {/if}
    {#if running}
      <div class="typing" class:stuck title={agent.lastEvent ? `Last event ${new Date(agent.lastEvent).toLocaleTimeString()}` : undefined}>
        <span></span><span></span><span></span>
        <b class="act">{activity || "Working"}</b>
        {#if quiet >= 30_000}<i class="quiet">· quiet for {shortDuration(quiet)}</i>{/if}
      </div>
      {#if stuck}
        <div class="stuckbox" role="status">
          <p>
            <b>No news for {shortDuration(quiet)}.</b>
            {activity ? `It may be stuck on ${activity}.` : "It may be stuck, or thinking for a long time."}
            A command that never ends (a dev server, a watch mode, a prompt waiting for input) keeps a run open.
          </p>
          <div class="opts">
            {#if agent.session}
              <button class="btn p" disabled={nudged} onclick={nudge} title="Cancel this run, then ask it in the same session where it is and to go on">
                {nudged ? "Stopping…" : "Stop and ask where it is"}
              </button>
            {/if}
            <button class="btn" onclick={() => app.cancelAgent(agent.id)}>Cancel</button>
          </div>
        </div>
      {/if}
    {/if}
    {#each queued as m, i (i)}
      <div class="you queued">
        <div class="bubble">{m}</div>
        <span class="qn">Sends when it stops <button onclick={() => app.unqueue(agent.id, i)} title="Do not send">✕</button></span>
      </div>
    {/each}
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
        ? "Write the next step: it is sent as soon as this run ends (Enter)"
        : q
          ? "Answer the question in words"
          : agent.session
            ? "Give it more work: same session, same worktree (Enter to send, Shift Enter for a new line)"
            : "This agent cannot be resumed: edit and rerun instead"}
    ></textarea>
    <button class="btn p" type="submit" disabled={!canSend || !text.trim()}>{q ? "Answer" : running ? "Queue" : "Send"}</button>
  </form>
</section>

<style>
  .queued {
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }
  .queued .bubble {
    opacity: 0.7;
    border: 1px dashed var(--line);
  }
  .qn {
    font-size: 11.5px;
    color: var(--faint);
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .qn button {
    all: unset;
    cursor: pointer;
    padding: 0 4px;
    border-radius: 4px;
  }
  .qn button:hover {
    background: var(--hover);
    color: var(--fg);
  }
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
  .next {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .nl {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--faint);
  }
  .next .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .next .btn small {
    color: var(--faint);
    font-size: 11px;
  }
  .next .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--c);
  }
  .title {
    flex: 1 1 100%;
    order: -1;
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card {
    max-width: 68ch;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    overflow: hidden;
    font-size: 13.5px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .card.old {
    opacity: 0.8;
  }
  .lead {
    padding: 12px 14px;
    font-size: 14px;
    border-left: 3px solid var(--space);
  }
  .sec {
    border-top: 1px solid var(--line);
  }
  .sh {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 8px 14px;
    font-size: 11.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    text-align: left;
  }
  .sh:hover {
    background: var(--hover);
  }
  .sh .chev {
    display: inline-block;
    transition: transform 0.15s var(--ease);
  }
  .sh .chev.open {
    transform: rotate(90deg);
  }
  .sb {
    padding: 0 14px 12px 28px;
    color: var(--fg);
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
  .applied {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    color: var(--muted);
    padding-left: 10px;
    border-left: 2px solid var(--add);
  }
  .applied.bad {
    border-left-color: var(--warn);
  }
  .tools li.said,
  .tools li.thought {
    white-space: pre-wrap;
    color: var(--muted);
  }
  .tools li.said {
    font-style: italic;
  }
  .tools li.thought {
    border-left: 2px solid var(--line);
    padding-left: 8px;
  }
  .tools li.thought small {
    display: block;
    color: var(--faint);
    font-size: 11px;
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
  .question.perm {
    box-shadow: 0 0 0 1.5px var(--info);
  }
  .question.allowed {
    box-shadow: 0 0 0 1.5px var(--add);
  }
  .question.denied {
    box-shadow: 0 0 0 1.5px var(--del);
  }
  .question.allowed small {
    color: var(--add);
  }
  .question.denied small {
    color: var(--del);
  }
  .question.pending small {
    color: var(--info);
  }
  .cmd {
    display: block;
    margin: 4px 0 0;
    font-family: var(--code);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .question.pending .cmd {
    margin-bottom: 8px;
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
    min-width: 0;
  }
  .typing .act {
    font-weight: 500;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .typing .quiet {
    flex: none;
    font-style: normal;
  }
  .typing.stuck .quiet {
    color: var(--warn);
    font-weight: 600;
  }
  .typing.stuck span {
    background: var(--warn);
  }
  .stuckbox {
    border-radius: 10px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--warn) 10%, var(--raised));
    border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
    font-size: 12.5px;
  }
  .stuckbox p {
    margin: 0 0 8px;
    color: var(--muted);
    line-height: 1.45;
  }
  .stuckbox b {
    color: var(--fg);
  }
  .sid {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 6px;
    color: var(--muted);
    border: 1px solid var(--line);
  }
  .sid:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .sid:focus-visible {
    outline: 2px solid var(--space);
  }
  .sk {
    font-family: var(--ui);
    color: var(--faint);
  }
  .label {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 9999px;
    color: var(--rc);
    background: color-mix(in srgb, var(--rc) 14%, transparent);
  }
  .label:hover {
    background: color-mix(in srgb, var(--rc) 24%, transparent);
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
