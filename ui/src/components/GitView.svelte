<script lang="ts">
  // The Git view: for each repo, where the space branch stands (against its base and its
  // upstream, what it changes, what is not committed) and the commit graph; the pull requests
  // under it.
  import { untrack } from "svelte";
  import { app } from "../lib/app.svelte";
  import type { GraphLine, RepoHistory } from "../lib/backend";
  import { colorOfRepo } from "../lib/colors";
  import { plural } from "../lib/format";
  import { shapes } from "../lib/graph";
  import Kbd from "./Kbd.svelte";
  import PrsView from "./PrsView.svelte";

  const sid = $derived(app.space.id);
  const list = $derived(app.history[sid]);
  const error = $derived(app.historyError[sid]);
  let open = $state<Record<string, boolean>>({});

  // Reload when the view opens and whenever the files of the space change.
  $effect(() => {
    const s = sid;
    void app.sd.status;
    untrack(() => void app.loadHistory(s));
  });

  const ROW = 28;
  const LINK = 12;
  const drawn = (lines: GraphLine[]) => {
    const hs = lines.map((l) => (l.hash ? ROW : LINK));
    return { hs, sh: shapes(lines.map((l) => l.graph), hs) };
  };
  const refKind = (r: string) => (r.startsWith("tag: ") ? "tag" : r.startsWith("HEAD") ? "head" : r.includes("/") && r.startsWith("origin/") ? "remote" : "local");
  const refText = (r: string) => r.replace(/^tag: /, "").replace(/^HEAD -> /, "");
  const shown = (h: RepoHistory) => (open[h.repo] ? h.lines : h.lines.slice(0, 40));
  const copy = (hash: string) => void navigator.clipboard?.writeText(hash).then(() => app.toast(`Copied ${hash}`));
  const commitsOf = (lines: GraphLine[]) => lines.filter((l) => l.hash).length;
</script>

<div class="git">
  <header class="top">
    <h3>Git</h3>
    <span class="sub">{app.space.branch}</span>
    <span class="grow"></span>
    <button class="btn ghost" onclick={() => void app.loadHistory()} title="Read the history again">Refresh</button>
    <button class="btn p" onclick={() => app.dispatch({ type: "open-commit" })} disabled={!app.staged.length} title={app.staged.length ? "Commit what is staged" : "Nothing staged"}>Commit <Kbd k="C" /></button>
  </header>

  {#if error}<div class="err">{error}</div>{/if}
  {#if !list}
    <div class="skel"></div>
  {:else}
    {#each list as h (h.repo)}
      <section class="repo" style:--rc={colorOfRepo(app.space, h.repo)}>
        <div class="rh">
          <b class="name">{h.repo}</b>
          <span class="br mono">{h.branch}</span>
          {#if h.base}<span class="arrow">from</span><span class="br mono base">{h.base}</span>{/if}
        </div>
        <div class="facts">
          {#if h.base}
            <span class="fact" title={`Commits on ${h.branch} that ${h.base} does not have, and the other way round`}>
              <b>{h.ahead}</b> ahead · <b class:warn={h.behind > 0}>{h.behind}</b> behind
            </span>
            <span class="fact" title={`What ${h.branch} changes since it left ${h.base}`}>
              <i class="a">+{h.added}</i> <i class="d">−{h.removed}</i> in {plural(h.files, "file", "files")}
            </span>
          {/if}
          <span class="fact" class:warn={h.unpushed === null || (h.unpushed ?? 0) > 0}>
            {#if h.unpushed === null}Not pushed yet{:else if h.unpushed}{plural(h.unpushed, "commit", "commits")} to push{:else}Pushed{/if}{#if h.unpulled}&nbsp;· {h.unpulled} to pull{/if}
          </span>
          {#if h.uncommitted}<button class="fact link" onclick={() => app.setView("review")}>{plural(h.uncommitted, "file", "files")} not committed <Kbd k="3" /></button>{/if}
          {#if h.stashes}<span class="fact">{plural(h.stashes, "stash", "stashes")}</span>{/if}
        </div>

        {#if !h.lines.length}
          <p class="empty">No commit yet.</p>
        {:else}
          {@const d = drawn(shown(h))}
          <ol class="graph">
            {#each shown(h) as l, i (i)}
              {@const s = d.sh[i]}
              <li class:commit={!!l.hash} class:mine={l.mine} style:height={`${d.hs[i]}px`}>
                <svg class="g" width={s.width} height={d.hs[i]} aria-hidden="true">
                  {#each s.segs as g, j (j)}<line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={g.color} stroke-width="2" stroke-linecap="round" />{/each}
                  {#if s.dot}<circle cx={s.dot.x} cy={d.hs[i] / 2} r={l.mine ? 4.5 : 3.5} fill={l.mine ? s.dot.color : "var(--panel)"} stroke={s.dot.color} stroke-width="2" />{/if}
                </svg>
                {#if l.hash}
                  <button class="hash mono" onclick={() => copy(l.hash)} title="Copy the hash">{l.hash}</button>
                  {#each l.refs as r (r)}<span class="ref" data-kind={refKind(r)}>{refText(r)}</span>{/each}
                  <span class="subj">{l.subject}</span>
                  <span class="who">{l.author}</span>
                  <span class="when">{l.when}</span>
                {/if}
              </li>
            {/each}
          </ol>
          {#if h.lines.length > 40}
            <button class="more" onclick={() => (open = { ...open, [h.repo]: !open[h.repo] })}>
              {open[h.repo] ? "Show less" : `Show ${commitsOf(h.lines.slice(40))} older commits`}
            </button>
          {/if}
        {/if}
      </section>
    {/each}
  {/if}

  <PrsView />
</div>

<style>
  .git {
    padding: 16px 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 1200px;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .top h3 {
    margin: 0;
    font-size: 16px;
  }
  .sub {
    font-family: var(--code);
    font-size: 12.5px;
    color: var(--faint);
  }
  .grow {
    flex: 1;
  }
  .ghost {
    background: transparent;
  }
  .ghost:hover {
    background: var(--hover);
  }
  .err {
    color: var(--del);
    font-size: 13px;
  }
  .skel {
    height: 220px;
    border-radius: 14px;
    background: var(--raised);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .repo {
    background: var(--raised);
    border-radius: 14px;
    padding: 14px 16px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: inset 3px 0 0 var(--rc);
  }
  .rh {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .name {
    font-size: 15px;
    color: var(--rc);
  }
  .br {
    font-size: 12.5px;
    padding: 1px 8px;
    border-radius: 6px;
    background: var(--panel);
  }
  .br.base {
    color: var(--muted);
  }
  .arrow {
    font-size: 12px;
    color: var(--faint);
  }
  .mono {
    font-family: var(--code);
  }
  .facts {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .fact {
    font-size: 12.5px;
    color: var(--muted);
    padding: 3px 10px;
    border-radius: 9999px;
    background: var(--panel);
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .fact b {
    color: var(--fg);
  }
  .fact .warn,
  .fact.warn {
    color: var(--warn);
  }
  .fact.link {
    all: unset;
    cursor: pointer;
    font-size: 12.5px;
    padding: 3px 10px;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--warn) 14%, var(--panel));
    display: inline-flex;
    gap: 6px;
    align-items: center;
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
  .empty {
    margin: 0;
    color: var(--faint);
    font-size: 13px;
  }
  .graph {
    list-style: none;
    margin: 0;
    padding: 6px 0;
    border-radius: 10px;
    background: var(--panel);
    font-size: 13px;
  }
  .graph li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    min-width: 0;
  }
  .graph li.commit:hover {
    background: var(--hover);
  }
  .g {
    flex: none;
    overflow: visible;
  }
  .hash {
    all: unset;
    cursor: pointer;
    flex: none;
    font-size: 12px;
    color: var(--faint);
  }
  .hash:hover {
    color: var(--fg);
    text-decoration: underline;
  }
  .ref {
    flex: none;
    font-size: 11px;
    font-weight: 600;
    padding: 0 7px;
    border-radius: 9999px;
    line-height: 18px;
    --c: var(--muted);
    color: var(--c);
    background: color-mix(in srgb, var(--c) 14%, transparent);
  }
  .ref[data-kind="head"] {
    --c: var(--space);
  }
  .ref[data-kind="remote"] {
    --c: var(--info);
  }
  .ref[data-kind="tag"] {
    --c: var(--warn);
  }
  .subj {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }
  .mine .subj {
    color: var(--fg);
    font-weight: 500;
  }
  .who,
  .when {
    flex: none;
    font-size: 12px;
    color: var(--faint);
  }
  .when {
    width: 110px;
    text-align: right;
  }
  .more {
    all: unset;
    cursor: pointer;
    align-self: flex-start;
    font-size: 12.5px;
    color: var(--muted);
    padding: 2px 6px;
    border-radius: 6px;
  }
  .more:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .git > :global(.prs) {
    padding: 0;
  }
</style>
