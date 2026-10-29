<script lang="ts">
  // One file of the stack of diffs in the Review: its header stays on top while you scroll its
  // diff. The diff is built when the card comes near the screen, and dropped when far from it.
  import { onDestroy, untrack } from "svelte";
  import { app, draftKey } from "../lib/app.svelte";
  import { findConflicts, resolve } from "../lib/conflicts";
  import { ROLE_COLORS, roleLabel } from "../lib/format";
  import type { ReviewNote } from "../lib/backend";
  import CommentThread from "./CommentThread.svelte";
  import Kbd from "./Kbd.svelte";
  import MergePane from "./MergePane.svelte";
  import type { FileRow } from "../lib/review";
  import { stackSel } from "../lib/reviewstack";

  let { row, selected, root }: { row: FileRow; selected: boolean; root: HTMLElement | undefined } = $props();
  const sid = $derived(app.space.id);
  const key = $derived(draftKey(sid, row.id));
  const fr = $derived(app.reviews[key]);

  let el: HTMLElement | undefined = $state();
  /** Near the screen: the diff is built. */
  let near = $state(false);
  /** Height of the diff when it was last built, kept while it is not, so the scroll does not jump. */
  let height = $state(0);
  let body: HTMLDivElement | undefined = $state();
  let observer: IntersectionObserver | null = null;
  $effect(() => {
    const target = el;
    if (!target || typeof IntersectionObserver === "undefined") {
      near = true;
      return;
    }
    observer?.disconnect();
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting && body) height = body.offsetHeight;
        near = e.isIntersecting;
      }
    }, { root: root ?? null, rootMargin: "900px 0px" });
    observer.observe(target);
    return () => observer?.disconnect();
  });
  onDestroy(() => observer?.disconnect());

  // Load what accepting gives when the card comes near, and again when the space data changes.
  $effect(() => {
    const r = row;
    const s = sid;
    void app.sd.hunks;
    void app.sd.status;
    if (near || selected) untrack(() => void app.loadReview(s, r));
  });

  const inReview = $derived(row?.section === "review");
  const fromAgents = $derived(!!fr && fr.agents.length > 0 && inReview);
  const serverAfter = $derived(!fr ? "" : fromAgents ? (fr.result ?? "") : (fr.mine ?? ""));
  const canCompare = $derived(fromAgents && !!fr && fr.mine !== fr.head);
  const before = $derived(!fr ? "" : fromAgents && (app.rvCompare === "incoming" || !canCompare) ? (fr.mine ?? "") : (fr.head ?? ""));
  const draft = $derived(key ? app.rvDrafts[key] : undefined);
  const after = $derived(draft ?? serverAfter);
  const conflicts = $derived(findConflicts(after));
  const deletes = $derived(fromAgents && fr?.result === null);
  const editable = $derived(inReview && !!fr && !fr.binary && !deletes);

  const reviewList = $derived(app.sections.review.flatMap((g) => g.files));
  const place = $derived(reviewList.findIndex((r) => r.id === row.id));
  const notes = $derived(app.notesOf(row.repo, row.path));
  const comments = $derived(app.commentsOf(row.repo, row.path));
  const commentDraft = $derived(app.commentDraft && app.commentDraft.repo === row.repo && app.commentDraft.path === row.path ? app.commentDraft : null);
  /** An accepted file shows its header only, until you open it. */
  let opened = $state(false);
  const shown = $derived(inReview || opened);
  const LEVEL_COLOR: Record<ReviewNote["level"], string> = { blocking: "var(--del)", warning: "var(--warn)", info: "var(--info)" };
  const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  let whyOpen = $state(false);

  /** What each agent with changes in this file said it did. */
  const why = $derived.by(() => {
    const ids = fr?.agents.length ? fr.agents : row.agents;
    return ids.map((id) => {
      const a = app.sd.agents.find((x) => x.id === id);
      return { id, role: a?.role ?? null, text: (a?.summary || a?.lastMessage || "").trim() };
    });
  });

  function change(doc: string) {
    app.setDraft(sid, row, doc === serverAfter ? null : doc);
  }
  function resolveAll(side: "mine" | "theirs") {
    change(resolve(after, side));
  }
  function comment(line: number) {
    seenHere();
    app.openCommentAt(row.repo, row.path, line);
  }
  /** A click in the card selects its file without scrolling the stack. */
  function seenHere() {
    if (app.rvs.sel !== row.id) stackSel.onScreen = row.id;
    app.rvSeen(row.id, "diff");
  }
  const estimate = $derived(Math.min(640, 72 + (row.add + row.del) * 22));
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<article
  class="rfile"
  class:sel={selected}
  class:done={!inReview}
  data-row={row.id}
  aria-label={`${row.repo}/${row.path}`}
  bind:this={el}
  onpointerdown={seenHere}
  onfocusin={seenHere}
>
  <header class="dh">
    <div class="title">
      {#if !inReview}
        <button class="fold" aria-expanded={opened} title={opened ? "Hide the diff" : "Show the diff"} onclick={() => (opened = !opened)}>{opened ? "▾" : "▸"}</button>
      {/if}
      <div class="path" title={`${row.repo}/${row.path}`}>
        {#if app.space.repos.length > 1}<em>{row.repo} / </em>{/if}<em>{dirOf(row.path)}</em><b>{nameOf(row.path)}</b>
      </div>
      {#if row.add || row.del}<span class="sz"><i class="a">+{row.add}</i> <i class="d">−{row.del}</i></span>{/if}
      {#if fromAgents}
        {#each why as w (w.id)}
          <span class="who" style:--c={w.role ? ROLE_COLORS[w.role] : "var(--warn)"}>{w.role ? roleLabel(w.role) : w.id}</span>
        {/each}
        {#if row.mine}<span class="who" style:--c="var(--muted)">+ your edits</span>{/if}
      {:else if inReview}
        <span class="who" style:--c="var(--muted)">Your edits</span>
      {/if}
      <span class="grow"></span>
      {#if inReview && place >= 0}<span class="place">{place + 1} of {reviewList.length}</span>{/if}
      <button class="mini" onclick={() => (app.rvSeen(row.id), app.rvOpenInEditor())} title="Open the file in the editor (E)">Open{#if selected} <Kbd k="E" />{/if}</button>
      {#if !inReview}
        <span class="accepted">✓ Accepted</span>
        <button class="btn" onclick={() => void app.rvStageRow(row)} title="Unstage it and review it again">Back to review{#if selected} <Kbd k="U" />{/if}</button>
      {:else}
        {#if fromAgents}
          <button class="btn" onclick={() => void app.rvRejectRow(row)} title="Throw away what the agents propose in this file. Your own edits stay">Reject{#if selected} <Kbd k="N" />{/if}</button>
        {/if}
        <button class="btn p" disabled={conflicts.length > 0} onclick={() => void app.rvStageRow(row)} title={conflicts.length ? "Resolve the conflicts first" : "Write this file as shown and stage it"}>
          ✓ Accept{#if selected} <Kbd k="Space" />{/if}
        </button>
      {/if}
    </div>
  </header>

  {#if shown}
    <div class="notes">
      {#if conflicts.length}
        <div class="banner warn">
          <div>
            <b>{conflicts.length === 1 ? "1 conflict" : `${conflicts.length} conflicts`} with your edits</b>
            <span>You and the agent changed the same lines. Pick a side on each below, or edit the text.</span>
          </div>
          <span class="grow"></span>
          <button class="btn" onclick={() => resolveAll("mine")}>Keep all yours</button>
          <button class="btn" onclick={() => resolveAll("theirs")}>Take all the agent's</button>
        </div>
      {/if}
      {#each fr?.notes ?? [] as n (n)}
        <div class="banner warn"><span>{n}</span></div>
      {/each}
      {#if deletes}
        <div class="banner del"><span><b>The agent deletes this file.</b> Accepting deletes it.</span></div>
      {/if}
      {#if draft !== undefined && inReview}
        <div class="banner info">
          <span><b>Edited by you.</b> Accepting writes the file as shown.</span>
          <span class="grow"></span>
          <button class="btn" onclick={() => app.setDraft(sid, row, null)}>Discard my edits</button>
        </div>
      {/if}
      {#if fromAgents && why.some((w) => w.text)}
        <button class="why" class:open={whyOpen} onclick={() => (whyOpen = !whyOpen)} title={whyOpen ? "Show less" : "What the agents said they did"}>
          {#each why.filter((w) => w.text) as w (w.id)}
            <span class="say" style:--c={w.role ? ROLE_COLORS[w.role] : "var(--warn)"}><b>{w.role ? roleLabel(w.role) : w.id}</b> {w.text}</span>
          {/each}
        </button>
      {/if}
      {#each notes as n (n.id)}
        {@render note(n)}
      {/each}
      {#each comments as c (c.id)}
        <CommentThread thread={c} />
      {/each}
      {#if commentDraft}
        <CommentThread line={commentDraft.line} />
      {/if}
    </div>

    <div class="body" bind:this={body} style:min-height={near && fr ? null : `${height || estimate}px`}>
      {#if !fr || !near}
        <div class="loading"><span class="pulse">Loading the file…</span></div>
      {:else if fr.binary}
        <div class="allclear">
          <h3>Binary file</h3>
          <span>No text to compare. {inReview ? "Accept or reject it as a whole." : ""}</span>
        </div>
      {:else if before === after && !deletes}
        <div class="allclear">
          <h3>{inReview ? "No line changes" : "Accepted as a whole"}</h3>
          <span>A new empty file or a mode change.</span>
        </div>
      {:else}
        <MergePane id={key} path={row.path} {before} {after} split={app.rvSplit} {editable} fit active={selected} onChange={change} onLine={comment} />
      {/if}
    </div>
  {/if}
</article>

{#snippet note(n: ReviewNote)}
  <div class="note" class:resolved={n.resolved} data-note={n.id} style:--c={n.resolved ? "var(--add)" : LEVEL_COLOR[n.level]}>
    <div class="nh">
      <span class="lvl">{n.resolved ? "resolved" : n.level}</span>
      <button class="ln" onclick={() => app.pane?.reveal(n.line)}>{n.by} · line {n.line}</button>
      <span class="grow"></span>
      {#if !n.resolved}
        <button class="mini" disabled={n.busy} onclick={() => void app.askFix(n.id)}>
          {#if n.busy}<span class="pulse">Fixing…</span>{:else}Ask to fix <Kbd k="F" />{/if}
        </button>
        <button class="mini" onclick={() => void app.resolveNote(n.id, true)}>Resolve</button>
      {:else}
        <button class="mini" onclick={() => void app.resolveNote(n.id, false)}>Reopen</button>
      {/if}
    </div>
    <p>{n.text}</p>
  </div>
{/snippet}

<style>
  .rfile {
    display: flex;
    flex-direction: column;
    background: var(--raised);
    border-radius: 12px;
    box-shadow: 0 0 0 1px var(--line);
    scroll-margin-top: 0;
  }
  .rfile.sel {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--space) 70%, transparent);
  }
  /* The header of the file stays on top while its diff scrolls under it. */
  .dh {
    position: sticky;
    top: 0;
    z-index: 3;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 12px;
    background: var(--raised);
    border-radius: 12px 12px 0 0;
    border-bottom: 1px solid var(--line);
  }
  .rfile.done .dh {
    border-bottom: none;
    border-radius: 12px;
  }
  .rfile.done .path {
    color: var(--muted);
  }
  .fold {
    all: unset;
    cursor: pointer;
    width: 16px;
    color: var(--muted);
    font-size: 12px;
  }
  .place {
    font-size: 12px;
    color: var(--faint);
  }
  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .title .btn {
    flex: none;
  }
  .path {
    min-width: 0;
    font-family: var(--code);
    font-size: 13.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path em {
    font-style: normal;
    color: var(--faint);
  }
  .path b {
    font-weight: 600;
  }
  .grow {
    flex: 1;
  }
  .who {
    font-size: 12px;
    font-weight: 700;
    color: var(--c);
    padding: 1px 8px;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--c) 14%, transparent);
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
  .accepted {
    font-weight: 700;
    color: var(--add);
    font-size: 13px;
  }
  .mini {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 7px;
    color: var(--muted);
  }
  .mini:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .mini:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .notes {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 14px 0;
  }
  .notes:empty {
    display: none;
  }
  .notes > :global(.thread) {
    margin: 0;
  }
  .banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 10px;
    font-size: 13px;
    background: color-mix(in srgb, var(--c) 13%, var(--panel));
    box-shadow: inset 3px 0 0 var(--c);
  }
  .banner div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .banner div span {
    color: var(--muted);
    font-size: 12.5px;
  }
  .banner .btn {
    height: 28px;
    font-size: 12.5px;
  }
  .banner.warn {
    --c: var(--warn);
  }
  .banner.del {
    --c: var(--del);
  }
  .banner.info {
    --c: var(--info);
  }
  .why {
    all: unset;
    cursor: pointer;
    display: flex;
    gap: 14px;
    padding: 7px 12px;
    border-radius: 10px;
    background: var(--panel);
    font-size: 13px;
    line-height: 1.5;
    color: var(--muted);
    min-width: 0;
  }
  .why:hover {
    color: var(--fg);
  }
  .say {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .say b {
    font-size: 12px;
    color: var(--c);
  }
  .why.open {
    flex-direction: column;
    gap: 6px;
  }
  .why.open .say {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--fg);
  }
  .note {
    padding: 8px 12px;
    border-radius: 10px;
    background: var(--panel);
    box-shadow: inset 3px 0 0 var(--c);
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  .note.resolved {
    opacity: 0.6;
  }
  .nh {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 12px;
    color: var(--muted);
  }
  .lvl {
    font-weight: 700;
    color: var(--c);
    text-transform: capitalize;
  }
  .ln {
    all: unset;
    cursor: pointer;
  }
  .ln:hover {
    color: var(--fg);
    text-decoration: underline;
  }
  .note p {
    margin: 0;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .body {
    margin-top: 8px;
    border-top: 1px solid var(--line);
    background: var(--panel);
    border-radius: 0 0 12px 12px;
    overflow: hidden;
  }
  .notes:empty + .body {
    margin-top: 0;
    border-top: none;
  }
  .loading {
    padding: 40px;
    text-align: center;
    color: var(--muted);
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
