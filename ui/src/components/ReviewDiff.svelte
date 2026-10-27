<script lang="ts">
  import { tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { openAtEvent } from "../lib/contextmenu.svelte";
  import { hunkMenu } from "../lib/menus";
  import { ROLE_COLORS, roleLabel, toolLabel } from "../lib/format";
  import { SECTION_TITLES } from "../lib/review";
  import type { ReviewComment, ReviewNote } from "../lib/backend";
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

  $effect(() => {
    cursor;
    row?.id;
    void tick().then(() => root?.querySelector<HTMLElement>("[data-focus='true']")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  });

  const proposalOf = (id: string) => app.proposals.find((p) => p.hunk.id === id);
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
      <h3>{app.sections.counts.staged ? "Everything is reviewed" : "Nothing to review"}</h3>
      <span>
        {#if app.sections.counts.staged}Press <Kbd k="C" /> to commit{:else}Pick a file on the left with <Kbd k="J" /> and <Kbd k="K" />{/if}
      </span>
    </div>
  {:else}
    <header class="dh">
      <div class="title">
        <span class="repo">{row.repo}</span>
        <b class="path"><em>{dirOf(row.path)}</em>{nameOf(row.path)}</b>
        <span class="grow"></span>
        {#if row.section === "staged"}
          <button class="btn" onclick={() => void app.rvStageRow(row)}>Unstage file <Kbd k="Space" /></button>
        {:else}
          <button class="btn p" onclick={() => void app.rvStageRow(row)}>
            ✓ {row.section === "proposed" ? "Accept file" : "Stage file"}
            <Kbd k="Space" />
          </button>
        {/if}
      </div>
      <div class="meta">
        <span class="badge" data-kind={row.section}>{SECTION_TITLES[row.section]}</span>
        {#if row.add || row.del}<span class="sz"><i class="a">+{row.add}</i> <i class="d">−{row.del}</i></span>{/if}
        {#if total}<span class="prog">{done} of {total} proposals reviewed</span>{/if}
        <span class="grow"></span>
        <button class="mode" onclick={() => app.dispatch({ type: "rv-split" })} title="Before and after side by side, or one column">
          {app.rvSplit ? "Side by side" : "Unified"} <Kbd k="V" />
        </button>
      </div>
    </header>
    {#each fileNotes as n (n.id)}
      {@render note(n)}
    {/each}
    {#each fileComments as c (c.id)}
      <CommentThread thread={c} />
    {/each}
    {#if !hunks.length}
      <div class="allclear">
        <h3>No hunks to show</h3>
        <span>This file was staged before, as a whole. Unstage it with <Kbd k="Space" />.</span>
      </div>
    {/if}
    {#each hunks as h, i (h.id)}
      {@const p = proposalOf(h.id)}
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
          {#if p}
            <span class="dot" style:--c={ROLE_COLORS[p.role]}></span>
            <b>{roleLabel(p.role)}</b>
            <span>{toolLabel(p.tool)}</span>
          {:else}
            <span class="dot" style:--c="var(--info)"></span>
            <b>You</b>
          {/if}
          <span class="loc">line {h.newStart}{h.section ? ` · ${h.section}` : ""}</span>
          <span class="acts">
            <button class="ghost" onclick={act(i, () => comment(h, i))} title="Comment: an agent answers">
              Comment {#if foc}<Kbd k="M" />{/if}
            </button>
            {#if h.state === "staged"}
              <span class="state">{p?.edited ? "edited by you" : "staged"}</span>
              <button class="ghost" onclick={act(i, () => app.rvHunkUnstage())}>Unstage {#if foc}<Kbd k="U" />{/if}</button>
            {:else}
              {#if p}
                <button class="ghost" onclick={act(i, () => app.rvHunkReject())}>Reject {#if foc}<Kbd k="N" />{/if}</button>
                <button class="ghost" onclick={act(i, () => app.dispatch({ type: "edit" }))}>Edit {#if foc}<Kbd k="E" />{/if}</button>
              {/if}
              <button class="ok" onclick={act(i, () => app.rvHunkStage())}>
                ✓ {p ? "Accept" : "Stage"}
                {#if foc}<Kbd k="Y" />{/if}
              </button>
            {/if}
          </span>
        </div>
        {#if p?.why}<div class="why">{p.why}</div>{/if}
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
    {#if hunks.length > 1 || pendingIn}
      <footer class="end">
        {#if pendingIn}
          <span>{pendingIn} of {hunks.length} hunks left in this file</span>
        {:else}
          <span>Every hunk of this file is staged</span>
        {/if}
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
  .repo {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--faint);
    flex: none;
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
  .badge {
    padding: 2px 9px;
    border-radius: 9999px;
    background: var(--hover);
    font-weight: 600;
  }
  .badge[data-kind="proposed"] {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 14%, transparent);
  }
  .badge[data-kind="staged"] {
    color: var(--add);
    background: color-mix(in srgb, var(--add) 14%, transparent);
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
  .hh b {
    color: var(--fg);
    font-weight: 600;
    font-size: 13.5px;
  }
  .loc {
    font-family: var(--code);
    color: var(--faint);
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
    padding: 0 14px 10px;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--fg);
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
    text-align: center;
    font-size: 12.5px;
    color: var(--faint);
    padding: 4px;
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
