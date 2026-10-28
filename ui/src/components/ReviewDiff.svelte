<script lang="ts">
  import { untrack } from "svelte";
  import { app, draftKey } from "../lib/app.svelte";
  import { findConflicts, resolve } from "../lib/conflicts";
  import { ROLE_COLORS, roleLabel } from "../lib/format";
  import type { ReviewNote } from "../lib/backend";
  import CommentThread from "./CommentThread.svelte";
  import Kbd from "./Kbd.svelte";
  import MergePane from "./MergePane.svelte";

  const row = $derived(app.selectedRow);
  const sid = $derived(app.space.id);
  const key = $derived(row ? draftKey(sid, row.id) : "");
  const fr = $derived(key ? app.reviews[key] : undefined);

  // Load what accepting gives whenever the file or the space data changes.
  $effect(() => {
    const r = row;
    const s = sid;
    void app.sd.hunks;
    void app.sd.status;
    if (r) untrack(() => void app.loadReview(s, r));
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
  const place = $derived(row ? reviewList.findIndex((r) => r.id === row.id) : -1);
  const notes = $derived(row ? app.notesOf(row.repo, row.path) : []);
  const comments = $derived(row ? app.commentsOf(row.repo, row.path) : []);
  const commentDraft = $derived(row && app.commentDraft && app.commentDraft.repo === row.repo && app.commentDraft.path === row.path ? app.commentDraft : null);
  const LEVEL_COLOR: Record<ReviewNote["level"], string> = { blocking: "var(--del)", warning: "var(--warn)", info: "var(--info)" };
  const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  let whyOpen = $state(false);

  /** What each agent with changes in this file said it did. */
  const why = $derived.by(() => {
    if (!row) return [];
    const ids = fr?.agents.length ? fr.agents : row.agents;
    return ids.map((id) => {
      const a = app.sd.agents.find((x) => x.id === id);
      return { id, role: a?.role ?? null, text: (a?.summary || a?.lastMessage || "").trim() };
    });
  });

  function change(doc: string) {
    if (!row) return;
    app.setDraft(sid, row, doc === serverAfter ? null : doc);
  }
  function resolveAll(side: "mine" | "theirs") {
    if (!row) return;
    change(resolve(after, side));
  }
  function comment(line: number) {
    if (row) app.openCommentAt(row.repo, row.path, line);
  }
</script>

<section class="diff" class:focused={app.rvs.focus === "diff"} aria-label="Diff">
  {#if !row}
    <div class="allclear">
      <h3>{app.sections.counts.done ? "Everything is reviewed" : "Nothing to review"}</h3>
      <span>
        {#if app.sections.counts.done}Press <Kbd k="C" /> to commit{:else}Changes of agents and your own edits show here{/if}
      </span>
    </div>
  {:else}
    <header class="dh">
      <div class="title">
        <div class="path" title={`${row.repo}/${row.path}`}>
          {#if app.space.repos.length > 1}<em>{row.repo} / </em>{/if}<em>{dirOf(row.path)}</em><b>{nameOf(row.path)}</b>
        </div>
        <span class="grow"></span>
        {#if !inReview}
          <span class="accepted">✓ Accepted</span>
          <button class="btn" onclick={() => void app.rvStageRow(row)} title="Unstage it and review it again">Back to review <Kbd k="U" /></button>
        {:else}
          {#if fromAgents}
            <button class="btn" onclick={() => void app.rvRejectRow(row)} title="Throw away what the agents propose in this file. Your own edits stay">Reject <Kbd k="N" /></button>
          {/if}
          <button class="btn p" disabled={conflicts.length > 0} onclick={() => void app.rvStageRow(row)} title={conflicts.length ? "Resolve the conflicts first" : "Write this file as shown and stage it"}>
            ✓ Accept{reviewList.length > 1 ? " and next" : ""} <Kbd k="Space" />
          </button>
        {/if}
      </div>
      <div class="meta">
        {#if inReview && place >= 0}<span>{place + 1} of {reviewList.length}</span>{/if}
        {#if fromAgents}
          {#each why as w (w.id)}
            <span class="who" style:--c={w.role ? ROLE_COLORS[w.role] : "var(--warn)"}>{w.role ? roleLabel(w.role) : w.id}</span>
          {/each}
          {#if row.mine}<span class="who" style:--c="var(--muted)">+ your edits</span>{/if}
        {:else if inReview}
          <span class="who" style:--c="var(--muted)">Your edits</span>
        {/if}
        {#if row.add || row.del}<span class="sz"><i class="a">+{row.add}</i> <i class="d">−{row.del}</i></span>{/if}
        <span class="grow"></span>
        {#if canCompare}
          <div class="seg" role="group" aria-label="Compare with">
            <button class:on={app.rvCompare === "incoming"} onclick={() => (app.rvCompare = "incoming")} title="Only what the agents change in your file">Agent changes</button>
            <button class:on={app.rvCompare === "commit"} onclick={() => (app.rvCompare = "commit")} title="Everything since the last commit, your edits included">All since commit</button>
          </div>
        {/if}
        <div class="seg" role="group" aria-label="Layout">
          <button class:on={!app.rvSplit} onclick={() => app.rvSplit && app.dispatch({ type: "rv-split" })}>Unified</button>
          <button class:on={app.rvSplit} onclick={() => !app.rvSplit && app.dispatch({ type: "rv-split" })}>Side by side</button>
        </div>
        <button class="mini" onclick={() => app.rvOpenInEditor()} title="Open the file in the editor (E)">Open <Kbd k="E" /></button>
      </div>
    </header>

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
          <button class="btn" onclick={() => row && app.setDraft(sid, row, null)}>Discard my edits</button>
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

    <div class="body">
      {#if !fr}
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
        <MergePane id={key} path={row.path} {before} {after} split={app.rvSplit} {editable} onChange={change} onLine={comment} />
      {/if}
    </div>
  {/if}
</section>

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
  .diff {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--raised);
    border-radius: 14px;
    overflow: hidden;
  }
  .dh {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--line);
  }
  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .title .btn {
    flex: none;
  }
  .path {
    min-width: 0;
    font-family: var(--code);
    font-size: 14.5px;
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
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12.5px;
    color: var(--muted);
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
  .seg {
    display: inline-flex;
    padding: 2px;
    border-radius: 8px;
    background: var(--hover);
  }
  .seg button {
    all: unset;
    cursor: pointer;
    font-size: 12px;
    padding: 3px 9px;
    border-radius: 6px;
    color: var(--muted);
  }
  .seg button.on {
    background: var(--panel);
    color: var(--fg);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.15);
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
    flex: none;
    max-height: 38%;
    overflow: auto;
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
    flex: 1;
    min-height: 0;
    margin-top: 8px;
    border-top: 1px solid var(--line);
    background: var(--panel);
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
