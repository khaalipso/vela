<script lang="ts">
  // A comment of yours on a line and the answers of the agent it went to. With no `thread`,
  // the box to write a new one (Enter sends, Shift Enter breaks the line, Esc cancels).
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import { app } from "../lib/app.svelte";
  import type { ReviewComment } from "../lib/backend";
  import Kbd from "./Kbd.svelte";

  let { thread = null, line = 0 }: { thread?: ReviewComment | null; line?: number } = $props();

  let text = $state("");
  let open = $state(false);
  let box: HTMLTextAreaElement | undefined = $state();
  const isNew = $derived(!thread);
  const md = (s: string) => DOMPurify.sanitize(marked.parse(s, { gfm: true, breaks: true, async: false }) as string);

  $effect(() => {
    if (isNew && box) {
      box.focus();
      box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  function send() {
    const t = text.trim();
    if (!t) return;
    text = "";
    open = false;
    if (thread) void app.replyComment(thread.id, t);
    else void app.sendComment(t);
  }
  function keys(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (thread) {
        open = false;
        text = "";
      } else app.commentDraft = null;
    }
  }
  function grow(e: Event) {
    const el = e.currentTarget as HTMLTextAreaElement;
    el.style.height = "auto";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="thread" class:resolved={thread?.resolved} onclick={(e) => e.stopPropagation()}>
  {#if thread}
    <header>
      <span class="ln">Line {thread.line}</span>
      <span class="who">{thread.by}</span>
      {#if thread.busy}<span class="pulse state">answering…</span>{:else if thread.waiting}<span class="state warn">needs you in Agents</span>{:else if thread.resolved}<span class="state ok">resolved</span>{/if}
      <span class="acts">
        {#if thread.resolved}
          <button class="lnk" onclick={() => void app.resolveComment(thread.id, false)}>Reopen</button>
        {:else}
          <button class="lnk" onclick={() => void app.resolveComment(thread.id, true)}>Resolve</button>
        {/if}
        <button class="lnk" title="Delete the thread" onclick={() => void app.deleteComment(thread.id)}>Delete</button>
      </span>
    </header>
    {#if !thread.resolved}
      {#each thread.messages as m, i (i)}
        <div class="msg" class:you={m.from === "you"}>
          <b>{m.from === "you" ? "You" : thread.by.split(" · ")[0]}</b>
          {#if m.from === "you"}
            <p>{m.text}</p>
          {:else}
            <div class="md">{@html md(m.text)}</div>
          {/if}
        </div>
      {/each}
      {#if thread.busy && thread.messages[thread.messages.length - 1]?.from === "you"}
        <div class="msg typing"><span class="dots"><i></i><i></i><i></i></span></div>
      {/if}
      {#if open}
        <textarea bind:this={box} bind:value={text} rows="1" placeholder="Answer…" onkeydown={keys} oninput={grow}></textarea>
      {:else if !thread.busy}
        <button
          class="reply"
          onclick={() => {
            open = true;
            setTimeout(() => box?.focus());
          }}>Reply…</button
        >
      {/if}
    {:else}
      <p class="gist">{thread.messages[0]?.text}</p>
    {/if}
  {:else}
    <header>
      <span class="ln">Comment line {line}</span>
      <span class="roles" role="radiogroup" aria-label="Who answers">
        <button role="radio" aria-checked={app.commentRole === "reviewer"} onclick={() => app.setCommentRole("reviewer")} title="Explains, changes nothing">
          Reviewer
        </button>
        <button role="radio" aria-checked={app.commentRole === "developer"} onclick={() => app.setCommentRole("developer")} title="Answers and changes the code">
          Developer
        </button>
      </span>
    </header>
    <textarea
      bind:this={box}
      bind:value={text}
      rows="2"
      placeholder={app.commentRole === "developer" ? "What should change here?" : "Ask about this line…"}
      onkeydown={keys}
      oninput={grow}
    ></textarea>
    <footer>
      <span class="hint"><Kbd k="Enter" /> send <Kbd k="Esc" /> cancel</span>
      <button class="btn" onclick={() => (app.commentDraft = null)}>Cancel</button>
      <button class="btn p" disabled={!text.trim()} onclick={send}>Send to {app.commentRole === "developer" ? "developer" : "reviewer"}</button>
    </footer>
  {/if}
</div>

<style>
  .thread {
    margin: 6px 14px 12px 60px;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--panel);
    box-shadow:
      0 0 0 1px var(--line),
      inset 3px 0 0 var(--space);
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13.5px;
    font-family: var(--ui);
    white-space: normal;
  }
  .thread.resolved {
    opacity: 0.7;
    box-shadow:
      0 0 0 1px var(--line),
      inset 3px 0 0 var(--add);
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--muted);
  }
  .ln {
    font-weight: 600;
    color: var(--fg);
  }
  .state {
    font-weight: 600;
  }
  .state.ok {
    color: var(--add);
  }
  .state.warn {
    color: var(--warn);
  }
  .acts,
  .roles {
    margin-left: auto;
    display: flex;
    gap: 4px;
  }
  .lnk {
    all: unset;
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 6px;
    color: var(--muted);
  }
  .lnk:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .roles button {
    all: unset;
    cursor: pointer;
    padding: 3px 10px;
    border-radius: 9999px;
    font-weight: 600;
    color: var(--muted);
    background: var(--hover);
  }
  .roles button[aria-checked="true"] {
    background: var(--space);
    color: var(--on-accent);
  }
  .msg {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .msg b {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
  }
  .msg.you b {
    color: var(--space);
  }
  .msg p,
  .gist {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .gist {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .md {
    line-height: 1.55;
    overflow-wrap: anywhere;
  }
  .md :global(p) {
    margin: 0 0 6px;
  }
  .md :global(p:last-child) {
    margin-bottom: 0;
  }
  .md :global(code) {
    font-family: var(--code);
    font-size: 12.5px;
    background: var(--hover);
    padding: 1px 4px;
    border-radius: 4px;
  }
  .md :global(pre) {
    background: var(--raised);
    padding: 8px 10px;
    border-radius: 8px;
    overflow-x: auto;
  }
  .md :global(pre code) {
    background: none;
    padding: 0;
  }
  .md :global(ul),
  .md :global(ol) {
    margin: 4px 0;
    padding-left: 20px;
  }
  textarea {
    all: unset;
    box-sizing: border-box;
    width: 100%;
    min-height: 38px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--raised);
    box-shadow: inset 0 0 0 1px var(--line);
    font: inherit;
    line-height: 1.5;
    white-space: pre-wrap;
    resize: none;
  }
  textarea:focus {
    box-shadow: inset 0 0 0 1.5px var(--space);
  }
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .hint {
    margin-right: auto;
    font-size: 12px;
    color: var(--faint);
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .reply {
    all: unset;
    cursor: text;
    padding: 7px 10px;
    border-radius: 8px;
    background: var(--raised);
    color: var(--faint);
  }
  .reply:hover {
    color: var(--muted);
  }
  .dots {
    display: inline-flex;
    gap: 4px;
    padding: 4px 0;
  }
  .dots i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--muted);
    animation: blink 1.2s infinite;
  }
  .dots i:nth-child(2) {
    animation-delay: 0.2s;
  }
  .dots i:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes blink {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }
</style>
