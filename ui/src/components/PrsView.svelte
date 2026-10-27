<script lang="ts">
  // Pull requests of the space, one per repo, from the GitHub CLI: state, checks, reviews,
  // comments on lines with their replies, and the conversation. A line comment opens the
  // file at its line, or goes to an agent for a fix.
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import { app } from "../lib/app.svelte";
  import type { PrCheck, RepoPr } from "../lib/backend";
  import { colorOfRepo } from "../lib/colors";
  import Kbd from "./Kbd.svelte";

  const st = $derived(app.prState);
  let drafts = $state<Record<string, string>>({});

  const md = (text: string) => DOMPurify.sanitize(marked.parse(text || "", { gfm: true, async: false }) as string);

  function ago(iso: string): string {
    const t = Date.parse(iso);
    if (!t) return "";
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  }

  const DECISION: Record<string, [string, string]> = {
    APPROVED: ["Approved", "var(--add)"],
    CHANGES_REQUESTED: ["Changes requested", "var(--del)"],
    REVIEW_REQUIRED: ["Review required", "var(--warn)"],
  };
  const REVIEW: Record<string, [string, string]> = {
    APPROVED: ["approved", "var(--add)"],
    CHANGES_REQUESTED: ["requested changes", "var(--del)"],
    COMMENTED: ["commented", "var(--info)"],
    DISMISSED: ["was dismissed", "var(--faint)"],
    PENDING: ["is reviewing", "var(--faint)"],
  };
  const CHECK: Record<PrCheck["state"], string> = {
    pass: "var(--add)",
    fail: "var(--del)",
    pending: "var(--warn)",
    skipped: "var(--faint)",
    neutral: "var(--faint)",
  };

  function checkSummary(r: RepoPr): string {
    const c = r.pr?.checks ?? [];
    if (!c.length) return "no checks";
    const fail = c.filter((x) => x.state === "fail").length;
    const pend = c.filter((x) => x.state === "pending").length;
    const pass = c.filter((x) => x.state === "pass").length;
    return [fail && `${fail} failing`, pend && `${pend} running`, pass && `${pass} passed`].filter(Boolean).join(" · ");
  }

  async function send(repo: string) {
    const body = drafts[repo]?.trim();
    if (!body) return;
    if (await app.commentPr(repo, body)) drafts[repo] = "";
  }

  const open = (url: string) => url && void app.backend.openUrl(url);
</script>

<div class="prs">
  <header class="top">
    <h3>Pull requests</h3>
    <span class="meta">
      {#if st.loading}<span class="pulse">Loading from GitHub…</span>{:else if st.at}Updated {ago(new Date(st.at).toISOString())}{/if}
    </span>
    <button class="btn" onclick={() => app.loadPrs(true)} disabled={st.loading}>Refresh <Kbd k="R" /></button>
  </header>

  {#if st.error}
    <div class="err">{st.error}</div>
  {/if}

  {#if !st.list.length && st.loading}
    {#each app.space.repos as r (r.name)}<div class="skel"></div>{/each}
  {/if}

  {#each st.list as r (r.repo)}
    {@const pr = r.pr}
    <section class="card" style:--rc={colorOfRepo(app.space, r.repo)} data-repo={r.repo}>
      <header class="ch">
        <span class="rdot"></span>
        <b class="repo">{r.repo}</b>
        {#if pr}
          <button class="title" onclick={() => open(pr.url)} title="Open on GitHub">#{pr.number} {pr.title}</button>
          <span class="badge state {pr.state.toLowerCase()}">{pr.draft ? "Draft" : pr.state.toLowerCase()}</span>
          {#if DECISION[pr.reviewDecision]}
            <span class="badge" style:--c={DECISION[pr.reviewDecision][1]}>{DECISION[pr.reviewDecision][0]}</span>
          {/if}
          <span class="size"><span class="a">+{pr.additions}</span> <span class="d">−{pr.deletions}</span></span>
        {:else}
          <span class="mono branch">{r.branch}</span>
        {/if}
      </header>

      {#if r.error}
        <p class="err">{r.error}</p>
      {:else if !pr}
        <div class="none">
          <span>No pull request for this branch yet.</span>
          <button class="btn p" onclick={() => app.createPr(r.repo)}>Push and open a pull request</button>
          <button class="btn" onclick={() => app.createPr(r.repo, true)}>As a draft</button>
        </div>
      {:else}
        <div class="grid">
          <div class="col">
            {#if pr.threads.length}
              <h4>On the code <span>{pr.threads.length}</span></h4>
              {#each pr.threads as t (t.id)}
                <article class="thread">
                  <div class="th">
                    <button class="loc mono" title="Open the file at this line" onclick={() => app.gotoLine(`${r.repo}/${t.path}`, t.line ?? 1)}>
                      {t.path}{t.line ? `:${t.line}` : " (outdated)"}
                    </button>
                    <span class="who">{t.author} · {ago(t.at)}</span>
                  </div>
                  <div class="body md">{@html md(t.body)}</div>
                  {#each t.replies as c, i (i)}
                    <div class="reply"><span class="who">{c.author} · {ago(c.at)}</span><div class="md">{@html md(c.body)}</div></div>
                  {/each}
                  <div class="tacts">
                    <button class="btn" onclick={() => app.fixPrComment(r.repo, t.body, `${t.path}${t.line ? `:${t.line}` : ""}`)}>Ask an agent to fix</button>
                    {#if t.url}<button class="lnk" onclick={() => open(t.url)}>Reply on GitHub</button>{/if}
                  </div>
                </article>
              {/each}
            {/if}

            <h4>Conversation <span>{pr.comments.length + pr.reviews.filter((v) => v.body).length}</span></h4>
            {#each pr.reviews.filter((v) => v.body) as v, i ("r" + i)}
              <article class="cmt">
                <span class="who"><b>{v.author}</b> <span style:color={REVIEW[v.state]?.[1]}>{REVIEW[v.state]?.[0] ?? v.state.toLowerCase()}</span> · {ago(v.at)}</span>
                <div class="md">{@html md(v.body)}</div>
                {#if v.state === "CHANGES_REQUESTED"}
                  <button class="btn" onclick={() => app.fixPrComment(r.repo, v.body)}>Ask an agent to fix</button>
                {/if}
              </article>
            {/each}
            {#each pr.comments as c, i ("c" + i)}
              <article class="cmt">
                <span class="who"><b>{c.author}</b> · {ago(c.at)}</span>
                <div class="md">{@html md(c.body)}</div>
              </article>
            {/each}
            <div class="say">
              <textarea
                bind:value={drafts[r.repo]}
                placeholder="Comment on the pull request"
                aria-label="Comment on {r.repo}"
                onkeydown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void send(r.repo);
                  }
                }}
              ></textarea>
              <button class="btn p" disabled={!drafts[r.repo]?.trim()} onclick={() => send(r.repo)}>Comment <kbd>Ctrl Enter</kbd></button>
            </div>
          </div>

          <aside class="side">
            <h4>Reviews</h4>
            {#each pr.reviews as v, i (i)}
              {@const s = REVIEW[v.state] ?? [v.state.toLowerCase(), "var(--faint)"]}
              <div class="rv"><span class="dot" style:--c={s[1]}></span><b>{v.author}</b><span>{s[0]}</span></div>
            {:else}
              <div class="muted">No review yet</div>
            {/each}
            {#each pr.requested as who (who)}
              <div class="rv"><span class="dot" style:--c="var(--faint)"></span><b>{who}</b><span>requested</span></div>
            {/each}

            <h4>Checks <span>{checkSummary(r)}</span></h4>
            {#each pr.checks as c, i (i)}
              <button class="ck" onclick={() => open(c.url)} disabled={!c.url} title={c.workflow}>
                <span class="dot" class:pulse={c.state === "pending"} style:--c={CHECK[c.state]}></span>
                <span class="nm">{c.name}</span>
                <span class="cs">{c.state}</span>
              </button>
            {/each}
            <div class="meta2">
              <span class="mono">{pr.head} → {pr.base}</span>
              {#if pr.mergeable === "CONFLICTING"}<span style:color="var(--del)">has conflicts</span>{/if}
            </div>
            <button class="btn" onclick={() => open(pr.url)}>Open on GitHub</button>
          </aside>
        </div>
      {/if}
    </section>
  {/each}
</div>

<style>
  .prs {
    padding: 16px 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 1200px;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .top h3 {
    margin: 0;
    font-size: 16px;
  }
  .meta {
    color: var(--faint);
    font-size: 12px;
    margin-right: auto;
  }
  .err {
    color: var(--del);
    font-size: 13px;
    background: var(--del-bg);
    padding: 8px 12px;
    border-radius: 10px;
    margin: 0;
  }
  .skel {
    height: 140px;
    border-radius: 14px;
    background: linear-gradient(90deg, var(--raised), var(--hover), var(--raised));
    background-size: 200% 100%;
    animation: shimmer 1.2s linear infinite;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
  .card {
    background: var(--raised);
    border-radius: 14px;
    padding: 12px 14px 14px;
    box-shadow: inset 3px 0 0 color-mix(in srgb, var(--rc) 80%, transparent);
  }
  .ch {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .rdot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--rc);
  }
  .repo {
    color: color-mix(in srgb, var(--rc) 70%, var(--fg));
  }
  .title {
    font-weight: 600;
    font-size: 14px;
    color: var(--fg);
    text-align: left;
  }
  .title:hover {
    text-decoration: underline;
  }
  .badge {
    padding: 1px 8px;
    border-radius: 9999px;
    font-size: 11px;
    background: color-mix(in srgb, var(--c, var(--faint)) 18%, transparent);
    color: var(--c, var(--muted));
    text-transform: capitalize;
  }
  .badge.state.open {
    --c: var(--add);
  }
  .badge.state.merged {
    --c: var(--syn-alt);
  }
  .badge.state.closed {
    --c: var(--del);
  }
  .size {
    margin-left: auto;
    font-family: var(--code);
    font-size: 12px;
  }
  .a {
    color: var(--add);
  }
  .d {
    color: var(--del);
  }
  .branch {
    color: var(--faint);
    font-size: 12px;
  }
  .none {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    color: var(--muted);
    font-size: 13px;
    padding-top: 10px;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 260px;
    gap: 18px;
    padding-top: 6px;
  }
  h4 {
    margin: 14px 0 8px;
    font-size: 12px;
    color: var(--faint);
    font-weight: 600;
    display: flex;
    gap: 6px;
  }
  h4 span {
    font-weight: 400;
  }
  .thread,
  .cmt {
    background: var(--panel);
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 8px;
    font-size: 13px;
  }
  .th {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }
  .loc {
    color: var(--info);
    font-size: 12px;
  }
  .loc:hover {
    text-decoration: underline;
  }
  .who {
    color: var(--faint);
    font-size: 12px;
  }
  .who b {
    color: var(--fg);
    font-weight: 600;
  }
  .reply {
    margin-top: 8px;
    padding-left: 10px;
    border-left: 2px solid var(--line);
  }
  .tacts {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 8px;
  }
  .lnk {
    font-size: 12px;
    color: var(--faint);
  }
  .lnk:hover {
    color: var(--fg);
  }
  .md {
    line-height: 1.55;
    overflow-wrap: anywhere;
  }
  .md :global(p) {
    margin: 4px 0;
  }
  .md :global(pre) {
    background: var(--raised);
    padding: 8px 10px;
    border-radius: 8px;
    overflow-x: auto;
  }
  .md :global(code) {
    font-family: var(--code);
    font-size: 12px;
  }
  .md :global(img) {
    max-width: 100%;
  }
  .md :global(a) {
    color: var(--info);
  }
  .say {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-end;
  }
  .say textarea {
    width: 100%;
    box-sizing: border-box;
    min-height: 64px;
    resize: vertical;
    background: var(--panel);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 8px 10px;
    font: inherit;
    font-size: 13px;
    outline: none;
  }
  .say textarea:focus {
    border-color: var(--space);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  .rv,
  .ck {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 26px;
  }
  .rv span:last-child {
    color: var(--faint);
    font-size: 12px;
  }
  .ck {
    text-align: left;
    border-radius: 6px;
    padding: 0 4px;
  }
  .ck:hover:not(:disabled) {
    background: var(--hover);
  }
  .ck .nm {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cs {
    color: var(--faint);
    font-size: 11px;
  }
  .muted {
    color: var(--faint);
    font-size: 12px;
  }
  .meta2 {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 12px 0 8px;
    font-size: 11px;
    color: var(--faint);
  }
  kbd {
    font-family: var(--code);
    font-size: 11px;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--hover);
  }
  @media (max-width: 900px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
