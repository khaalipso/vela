<script lang="ts">
  import { tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { openAtEvent } from "../lib/contextmenu.svelte";
  import { hunkMenu } from "../lib/menus";
  import { ROLE_COLORS, roleLabel, toolLabel } from "../lib/format";
  import type { ReviewNote } from "../lib/backend";
  import type { Hunk } from "../lib/types";
  import CommentThread from "./CommentThread.svelte";
  import DiffBlock from "./DiffBlock.svelte";
  import Kbd from "./Kbd.svelte";
  import SplitDiff from "./SplitDiff.svelte";

  const row = $derived(app.selectedRow);
  const hunks = $derived(app.selectedHunks);
  const cursor = $derived(app.rvs.hunk);
  const total = $derived(app.proposals.length);
  const done = $derived(app.accepted.length + app.rejected.length);
  let root: HTMLElement | undefined = $state();

  // A new file starts at its top (what the agent says first); moving between hunks follows the cursor.
  let shownRow: string | null = null;
  $effect(() => {
    const id = row?.id ?? null;
    cursor;
    void tick().then(() => {
      if (id !== shownRow) {
        shownRow = id;
        if (root) root.scrollTop = 0;
        return;
      }
      root?.querySelector<HTMLElement>("[data-focus='true']")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  });

  const proposalOf = (id: string) => app.proposals.find((p) => p.hunk.id === id);
  const authorOf = (h: Hunk) => (h.origin.type === "agent" ? (app.sd.agents.find((a) => a.id === (h.origin as { agent: string }).agent)?.role ?? null) : null);
  const notes = $derived(row ? app.notesOf(row.repo, row.path) : []);
  const comments = $derived(row ? app.commentsOf(row.repo, row.path) : []);
  const hunkIds = $derived(new Set(hunks.map((h) => h.id)));
  /** Notes and comments of the file that fall in none of the hunks shown. */
  const fileNotes = $derived(notes.filter((n) => !n.hunkId || !hunkIds.has(n.hunkId)));
  const fileComments = $derived(comments.filter((c) => !c.hunkId || !hunkIds.has(c.hunkId)));
  const notesOfHunk = (id: string) => notes.filter((n) => n.hunkId === id);
  const commentsOfHunk = (id: string) => comments.filter((c) => c.hunkId === id);
  const markedOf = (id: string) => new Set([...notesOfHunk(id).map((n) => n.line), ...commentsOfHunk(id).map((c) => c.line)]);
  const draft = $derived(app.commentDraft);
  const LEVEL_COLOR: Record<ReviewNote["level"], string> = { blocking: "var(--del)", warning: "var(--warn)", info: "var(--info)" };
  const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const pendingIn = $derived(hunks.filter((h) => h.state === "pending").length);
  const reviewList = $derived(app.sections.review.flatMap((g) => g.files));
  const place = $derived(row ? reviewList.findIndex((r) => r.id === row.id) : -1);
  /** What each agent with changes in this file said it did. */
  const why = $derived.by(() => {
    if (!row) return [];
    return row.agents.map((id) => {
      const a = app.sd.agents.find((x) => x.id === id);
      return { id, role: a?.role ?? null, text: a?.summary || a?.lastMessage || "" };
    });
  });
  const lineSpan = (h: Hunk) => (h.newLines > 1 ? `Lines ${h.newStart}–${h.newStart + h.newLines - 1}` : `Line ${h.newStart}`);

  function act(i: number, f: () => unknown) {
    return (e: MouseEvent) => {
      e.stopPropagation();
      app.rvHunkSet(i);
      void f();
    };
  }
  function comment(h: Hunk, i: number, line?: number) {
    app.rvHunkSet(i);
    app.openComment(h, line);
  }
</script>

<section class="diff" bind:this={root} class:focused={app.rvs.focus === "diff"} aria-label="Diff">
  {#if !row}
    <div class="allclear">
      <h3>{app.sections.counts.done ? "Everything is reviewed" : "Nothing to review"}</h3>
      <span>
        {#if app.sections.counts.done}Press <Kbd k="C" /> to commit{:else}Pick a file on the left with <Kbd k="J" /> and <Kbd k="K" />{/if}
      </span>
    </div>
  {:else}
    <header class="dh">
      <div class="title">
        <b class="path"><em>{row.repo !== app.space.repos[0]?.name || app.space.repos.length > 1 ? `${row.repo} / ` : ""}{dirOf(row.path)}</em>{nameOf(row.path)}</b>
        <span class="grow"></span>
        {#if row.section === "done"}
          <span class="accepted">✓ Accepted</span>
          <button class="btn" onclick={() => void app.rvStageRow(row)}>Back to review <Kbd k="Space" /></button>
        {:else}
          {#if row.agents.length}
            <button class="btn" onclick={() => void app.rvRejectRow(row)} title="Throw away what the agents propose in this file">Reject</button>
          {/if}
          <button class="btn p" onclick={() => void app.rvStageRow(row)}>✓ Accept file <Kbd k="Space" /></button>
        {/if}
      </div>
      <div class="meta">
        {#if place >= 0}<span>File {place + 1} of {reviewList.length} to review</span>{/if}
        {#if row.add || row.del}<span class="sz"><i class="a">+{row.add}</i> <i class="d">−{row.del}</i></span>{/if}
        {#if hunks.length > 1}<span>{hunks.length} changes{pendingIn && pendingIn < hunks.length ? `, ${pendingIn} waiting` : ""}</span>{/if}
        <span class="grow"></span>
        <button class="mode" onclick={() => app.dispatch({ type: "rv-split" })} title="Before and after side by side, or one column">
          {app.rvSplit ? "Side by side" : "Unified"} <Kbd k="V" />
        </button>
      </div>
    </header>
    {#each why as w (w.id)}
      {#if w.text}
        <div class="why" style:--c={w.role ? ROLE_COLORS[w.role] : "var(--warn)"}>
          <b>{w.role ? roleLabel(w.role) : w.id} says</b>
          <p>{w.text}</p>
        </div>
      {/if}
    {/each}
    {#each fileNotes as n (n.id)}
      {@render note(n)}
    {/each}
    {#each fileComments as c (c.id)}
      <CommentThread thread={c} />
    {/each}
    {#if !hunks.length}
      <div class="allclear">
        <h3>{row.section === "done" ? "Accepted as a whole" : "No line to show"}</h3>
        <span>A new empty file, a binary file or a mode change. {row.section === "done" ? "" : "Accept it with Space."}</span>
      </div>
    {/if}
    {#each hunks as h, i (h.id)}
      {@const p = proposalOf(h.id)}
      {@const role = authorOf(h)}
      {@const foc = i === cursor}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <article
        class="hunk"
        class:focus={foc}
        class:staged={h.state === "staged"}
        data-focus={foc}
        data-state={h.state}
        onclick={() => app.rvHunkSet(i)}
        oncontextmenu={(e) => {
          app.rvHunkSet(i);
          openAtEvent(e, hunkMenu(h), "Hunk");
        }}
      >
        <div class="hh">
          <span class="loc">{lineSpan(h)}{h.section ? ` · ${h.section}` : ""}</span>
          {#if h.origin.type === "agent"}
            <span class="by" style:--c={role ? ROLE_COLORS[role] : "var(--warn)"}>{role ? roleLabel(role) : "Agent"}{p ? ` · ${toolLabel(p.tool)}` : ""}</span>
          {:else}
            <span class="by" style:--c="var(--muted)">You</span>
          {/if}
          <span class="acts">
            <button class="ghost" onclick={act(i, () => comment(h, i))} title="Comment this change: an agent answers (M)">Comment</button>
            {#if h.state === "staged"}
              <span class="state">✓ {p?.edited ? "Accepted, edited" : "Accepted"}</span>
              <button class="ghost" onclick={act(i, () => app.rvHunkUnstage())} title="Back to review (U)">Undo</button>
            {:else}
              {#if h.origin.type === "agent"}
                <button class="ghost" onclick={act(i, () => app.rvHunkReject())} title="Reject this change (N)">Reject</button>
                <button class="ghost" onclick={act(i, () => app.dispatch({ type: "edit" }))} title="Accept and change it by hand (E)">Edit</button>
              {/if}
              <button class="ok" onclick={act(i, () => app.rvHunkStage())} title="Accept this change only (Y)">✓ Accept</button>
            {/if}
          </span>
        </div>
        {#if app.rvSplit}
          <SplitDiff hunk={h} />
        {:else}
          <DiffBlock hunk={h} marked={markedOf(h.id)} onComment={(line) => comment(h, i, line)} />
        {/if}
        {#each notesOfHunk(h.id) as n (n.id)}
          {@render note(n)}
        {/each}
        {#each commentsOfHunk(h.id) as c (c.id)}
          <CommentThread thread={c} />
        {/each}
        {#if draft && draft.hunkId === h.id}
          <CommentThread line={draft.line} />
        {/if}
      </article>
    {/each}
    {#if row.section === "review" && hunks.length}
      <footer class="end">
        <button class="btn p big" onclick={() => void app.rvStageRow(row)}>
          ✓ Accept file{reviewList.length > 1 ? " and go to the next" : ""}
          <Kbd k="Space" />
        </button>
      </footer>
    {/if}
  {/if}
</section>

{#snippet note(n: ReviewNote)}
  <div class="note" class:resolved={n.resolved} data-note={n.id} style:--c={n.resolved ? "var(--add)" : LEVEL_COLOR[n.level]}>
    <div class="nh">
      <span class="lvl">{n.resolved ? "resolved" : n.level}</span>
      <span>{n.by} · line {n.line}</span>
    </div>
    <p>{n.text}</p>
    <div class="nacts">
      {#if !n.resolved}
        <button
          class="btn"
          disabled={n.busy}
          onclick={(e) => {
            e.stopPropagation();
            void app.askFix(n.id);
          }}
        >
          {#if n.busy}<span class="pulse">Fixing…</span>{:else}Ask to fix <Kbd k="F" />{/if}
        </button>
        <button
          class="btn"
          onclick={(e) => {
            e.stopPropagation();
            void app.resolveNote(n.id, true);
          }}>Resolve <Kbd k="Shift Y" /></button
        >
      {:else}
        <button
          class="btn"
          onclick={(e) => {
            e.stopPropagation();
            void app.resolveNote(n.id, false);
          }}>Reopen</button
        >
      {/if}
    </div>
  </div>
{/snippet}

<style>
  .diff {
    min-width: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 0 4px 16px 2px;
  }
  .dh {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 6px 4px 10px;
    position: sticky;
    top: 0;
    background: var(--panel);
    z-index: 2;
    box-shadow: 0 1px 0 var(--line);
  }
  .title .btn {
    flex: none;
    align-self: center;
  }
  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .path {
    font-family: var(--code);
    font-size: 15px;
    font-weight: 600;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .path em {
    font-style: normal;
    font-weight: 400;
    color: var(--faint);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 12.5px;
    color: var(--muted);
  }
  .grow {
    flex: 1;
  }
  .sz {
    font-family: var(--code);
  }
  i {
    font-style: normal;
  }
  .a {
    color: var(--add);
  }
  .d {
    color: var(--del);
  }
  .hunk {
    background: var(--raised);
    border-radius: 14px;
    overflow: hidden;
    box-shadow:
      0 0 0 1px transparent,
      inset 3px 0 0 transparent;
    transition:
      box-shadow 240ms var(--ease),
      opacity 240ms var(--ease);
    flex: none;
    scroll-margin-top: 110px;
  }
  .hunk.staged {
    box-shadow: inset 3px 0 0 var(--add);
    opacity: 0.75;
  }
  .hunk.staged:hover,
  .hunk.staged.focus {
    opacity: 1;
  }
  .hunk.focus {
    box-shadow: 0 0 0 2px var(--space);
  }
  .hunk.focus.staged {
    box-shadow:
      0 0 0 2px var(--space),
      inset 3px 0 0 var(--add);
  }
  .hh {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 8px 10px 8px 14px;
    font-size: 12.5px;
    color: var(--muted);
  }
  .loc {
    font-family: var(--code);
    color: var(--fg);
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40ch;
  }
  .acts {
    margin-left: auto;
    display: flex;
    gap: 4px;
    align-items: center;
    flex-wrap: wrap;
  }
  .ghost,
  .ok {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: 8px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--muted);
  }
  .ghost:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .ok {
    color: var(--add);
    background: color-mix(in srgb, var(--add) 14%, transparent);
  }
  .ok:hover {
    background: color-mix(in srgb, var(--add) 24%, transparent);
  }
  .state {
    font-weight: 600;
    color: var(--add);
    padding: 0 6px;
  }
  .why {
    flex: none;
    padding: 10px 14px;
    border-radius: 12px;
    background: var(--raised);
    box-shadow: inset 3px 0 0 var(--c);
    font-size: 13.5px;
  }
  .why b {
    font-size: 12px;
    font-weight: 700;
    color: var(--c);
  }
  .why p {
    margin: 4px 0 0;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .accepted {
    font-weight: 700;
    color: var(--add);
    font-size: 13px;
  }
  .by {
    font-size: 12px;
    font-weight: 700;
    color: var(--c);
  }
  .big {
    height: 40px;
    padding: 0 18px;
    font-size: 14px;
  }
  .note {
    margin: 6px 14px 12px 60px;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--panel);
    box-shadow:
      0 0 0 1px var(--line),
      inset 3px 0 0 var(--c);
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13.5px;
  }
  .diff > .note {
    margin: 0;
  }
  .diff > :global(.thread) {
    margin: 0;
  }
  .nh {
    display: flex;
    gap: 10px;
    align-items: center;
    font-size: 12px;
    color: var(--muted);
  }
  .lvl {
    font-weight: 700;
    color: var(--c);
    text-transform: capitalize;
  }
  .note p {
    margin: 0;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .nacts {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .note .btn {
    height: 28px;
    font-size: 12.5px;
  }
  .note.resolved {
    opacity: 0.6;
  }
  .mode {
    font-size: 12.5px;
    color: var(--muted);
    display: inline-flex;
    gap: 6px;
    align-items: center;
    padding: 4px 8px;
    border-radius: 8px;
  }
  .mode:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .end {
    display: flex;
    justify-content: center;
    padding: 8px 4px 24px;
  }
  .allclear {
    padding: 48px 20px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    color: var(--muted);
  }
  .allclear h3 {
    margin: 0;
    color: var(--fg);
    font-size: 18px;
    font-weight: 600;
  }
</style>
