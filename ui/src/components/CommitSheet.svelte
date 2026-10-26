<script lang="ts">
  import { tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { composeHeader } from "../lib/commitplan";
  import { plural, uniq } from "../lib/format";
  import Kbd from "./Kbd.svelte";

  const g = $derived(app.gate);
  const c = $derived(app.cc);
  const fails = $derived(!!g && g.done && app.gateRows.some((x) => !x.pass && x.detail !== "running" && x.detail !== "not run"));
  const repos = $derived(c ? uniq(c.groups.map((x) => x.repo)) : []);

  /** What a hunk id stands for: a path and its size, or a stand in when the hunk is not known. */
  function row(id: string): { path: string; add: number; del: number; note: string } {
    const h = c?.hunks[id];
    if (h) {
      const add = h.lines.filter((l) => l.kind === "add").length;
      return { path: h.path, add, del: h.lines.length - add - h.lines.filter((l) => l.kind === "context").length, note: "" };
    }
    if (id.startsWith("base:")) return { path: id.slice(5).split("/").slice(1).join("/"), add: 0, del: 0, note: "staged earlier" };
    if (id.startsWith("f:")) return { path: "File without changes in its lines", add: 0, del: 0, note: "moved or renamed" };
    return { path: id, add: 0, del: 0, note: "" };
  }

  const TYPE_COLOR: Record<string, string> = {
    feat: "var(--add)",
    fix: "var(--warn)",
    refactor: "var(--syn-alt)",
    perf: "var(--info)",
    test: "var(--info)",
    docs: "var(--muted)",
    style: "var(--muted)",
    build: "var(--syn-alt)",
    ci: "var(--syn-alt)",
    chore: "var(--muted)",
    revert: "var(--del)",
  };

  // Keep the focused commit in view.
  $effect(() => {
    const id = c?.groups[c.gi]?.id;
    if (!id) return;
    void tick().then(() => document.querySelector(`[data-group="${id}"]`)?.scrollIntoView({ block: "nearest" }));
  });

  const setScope = (i: number, v: string) => {
    if (!c) return;
    c.groups[i].scope = v.trim() ? v : null;
    void app.revalidate(c.groups[i].id);
  };
  const setFooters = (i: number, v: string) => {
    if (!c) return;
    c.groups[i].footers = v.split("\n");
    void app.revalidate(c.groups[i].id);
  };
</script>

{#if g && c}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(e) => e.target === e.currentTarget && app.closeOverlay()}>
    <div class="sheet" role="dialog" aria-label="Commit composer">
      <div class="form">
        <div class="head">
          <span class="dot" style:--c={app.space.color}></span>
          <span class="ttl">Commit {app.space.name}</span>
          <span class="cost right">{plural(c.groups.length, "commit", "commits")} · {repos.join(", ")}</span>
        </div>
        <ul class="checks">
          {#if !app.gateRows.length}
            <li><span class="dot" style:--c="var(--faint)"></span><span>No checks configured</span><em style:--c="var(--faint)">skipped</em></li>
          {/if}
          {#each app.gateRows as k, i (i)}
            {@const col = k.pass ? "var(--add)" : k.detail === "running" || k.detail === "not run" ? "var(--faint)" : "var(--del)"}
            <li>
              <span class="dot" class:pulse={k.detail === "running"} style:--c={col}></span>
              <span>{k.name}</span>
              <em style:--c={col}>{k.detail}</em>
            </li>
          {/each}
        </ul>
        <div class="cost">Results of the checks in the Review view for exactly this staged set. Unchanged files come from cache.</div>
        {#if app.pending.length}
          <div class="blocked">{app.pending.length} proposals are still unreviewed and will not be committed.</div>
        {/if}

        <div class="mode">
          <span class="cost">{c.conventional ? "Conventional commits" : "Plain messages"}: this repo {c.conventional ? "uses them" : "does not use them"}.</span>
          <button class="btn mini" onclick={() => app.ccConventional()}>{c.conventional ? "Turn off" : "Turn on"} <Kbd k="O" /></button>
        </div>

        <div class="cards">
          {#each c.groups as grp, i (grp.id)}
            {@const probs = c.problems[grp.id] ?? []}
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div
              class="card"
              class:focus={i === c.gi}
              data-group={grp.id}
              onfocusin={() => app.ccFocus(i)}
              onclick={() => app.ccFocus(i)}
            >
              <div class="r1">
                <span class="num">{i + 1}</span>
                {#if c.conventional}
                  <button
                    class="pill"
                    style:--c={TYPE_COLOR[grp.kind] ?? "var(--muted)"}
                    title="Cycle the type"
                    onclick={() => {
                      app.ccFocus(i);
                      app.ccType();
                    }}>{grp.kind}</button
                  >
                  <input
                    class="field scope"
                    data-field="scope"
                    aria-label="Scope of commit {i + 1}"
                    autocomplete="off"
                    placeholder="scope"
                    value={grp.scope ?? ""}
                    oninput={(e) => setScope(i, e.currentTarget.value)}
                  />
                  <button
                    class="bang"
                    aria-pressed={!!grp.breaking}
                    title="Breaking change"
                    onclick={() => {
                      app.ccFocus(i);
                      app.ccBreaking();
                    }}>!</button
                  >
                {/if}
                <input
                  class="field subject"
                  data-field="subject"
                  aria-label="Subject of commit {i + 1}"
                  autocomplete="off"
                  placeholder="What this commit does"
                  bind:value={grp.subject}
                  oninput={() => app.revalidate(grp.id)}
                />
                <span class="repo mono">{grp.repo}</span>
              </div>
              <div class="prev mono" class:bad={probs.length > 0}>{composeHeader(grp, c.conventional)}</div>
              {#if grp.breaking && c.conventional}
                <input
                  class="field reason"
                  data-field="reason"
                  aria-label="What breaks in commit {i + 1}"
                  autocomplete="off"
                  placeholder="What breaks, for the BREAKING CHANGE footer"
                  bind:value={grp.breakingReason}
                  oninput={() => app.revalidate(grp.id)}
                />
              {/if}
              {#if probs.length}
                <ul class="probs">
                  {#each probs as p (p.message)}<li>{p.message}</li>{/each}
                </ul>
              {/if}
              {#if i === c.gi}
                <textarea
                  class="field body mono"
                  data-field="body"
                  aria-label="Body of commit {i + 1}"
                  rows="2"
                  placeholder="Body (optional)"
                  bind:value={grp.body}
                  oninput={() => app.revalidate(grp.id)}
                ></textarea>
                <textarea
                  class="field body mono"
                  data-field="footers"
                  aria-label="Footers of commit {i + 1}"
                  rows="1"
                  placeholder="Footers, one per line: Refs: PAY-412"
                  value={(grp.footers ?? []).join("\n")}
                  oninput={(e) => setFooters(i, e.currentTarget.value)}
                ></textarea>
                <ul class="hunks" aria-label="Hunks of commit {i + 1}">
                  {#each grp.hunks as id, k (id)}
                    {@const r = row(id)}
                    <li class:sel={k === c.hi}>
                      <button
                        class="hk"
                        onclick={() => {
                          c.hi = k;
                        }}
                      >
                        <span class="p mono">{r.path}</span>
                        {#if r.note}<span class="n">{r.note}</span>{:else}<span class="a">+{r.add}</span><span class="d">−{r.del}</span>{/if}
                      </button>
                    </li>
                  {/each}
                </ul>
              {:else if (grp.footers ?? []).length}
                <div class="foot mono">{(grp.footers ?? []).join(" · ")}</div>
              {/if}
            </div>
          {/each}
        </div>

        {#if fails}
          <div class="grp">
            <label for="ov-in" class="bad">Blocked. Fix it with F in review, or give a reason to override</label>
            <input class="field" id="ov-in" autocomplete="off" placeholder="Hotfix, tests are flaky on CI" bind:value={g.reason} />
          </div>
        {/if}
        <div class="actions">
          <button class="btn" onclick={() => app.closeOverlay()}>Cancel</button>
          <button class="btn p" disabled={!app.gateOk || !app.composerOk} onclick={() => app.doCommit()}>
            Commit {plural(c.groups.length, "commit", "commits")} <Kbd k="Ctrl Enter" />
          </button>
        </div>
      </div>
      <div class="pfoot">
        <span><Kbd k="T" /> type</span>
        <span><Kbd k="!" /> breaking</span>
        <span><Kbd k="J" /><Kbd k="K" /> hunk</span>
        <span><Kbd k="1" /> to <Kbd k="9" /> move it</span>
        <span><Kbd k="G" /> new commit</span>
        <span><Kbd k="M" /> merge</span>
        <span><Kbd k="Tab" /> fields</span>
        <span><Kbd k="Esc" /> field, then close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim :global(.sheet) {
    max-width: 760px;
  }
  .scrim {
    overflow: auto;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ttl {
    font-size: 16px;
    font-weight: 600;
  }
  .right {
    margin-left: auto;
  }
  .checks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .checks li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-radius: 10px;
    background: var(--raised);
  }
  .checks li span:nth-child(2) {
    flex: 1;
  }
  .checks li em {
    font-style: normal;
    font-size: 12px;
    color: var(--c);
  }
  .blocked {
    font-size: 12px;
    color: var(--del);
  }
  .mode {
    display: flex;
    align-items: center;
    gap: 10px;
    justify-content: space-between;
  }
  .mini {
    height: 26px;
    font-size: 12px;
    padding: 0 10px;
  }
  .cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-radius: 12px;
    background: var(--raised);
    box-shadow: 0 0 0 1.5px transparent;
    transition: box-shadow 160ms var(--ease);
  }
  .card.focus {
    box-shadow: 0 0 0 1.5px var(--space);
  }
  .r1 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .num {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 6px;
    background: var(--hover);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .pill {
    flex: none;
    height: 26px;
    padding: 0 10px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--c) 16%, transparent);
    color: var(--c);
    font-size: 12px;
    font-weight: 600;
  }
  .card .field {
    height: 32px;
    font-size: 13px;
    background: var(--hover);
  }
  .scope {
    width: 110px;
    flex: none;
  }
  .subject {
    flex: 1;
    min-width: 0;
    width: auto;
  }
  .bang {
    flex: none;
    width: 26px;
    height: 26px;
    border-radius: 8px;
    background: var(--hover);
    color: var(--faint);
    font-weight: 700;
  }
  .bang[aria-pressed="true"] {
    background: var(--del-bg);
    color: var(--del);
  }
  .repo {
    flex: none;
    font-size: 11px;
    color: var(--faint);
  }
  .prev {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .prev.bad {
    color: var(--del);
  }
  .probs {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 12px;
    color: var(--del);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  textarea.body {
    font-size: 12px;
    min-height: 0;
  }
  .foot {
    font-size: 11px;
    color: var(--faint);
  }
  .hunks {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .hunks li.sel .hk {
    background: var(--hover);
    box-shadow: inset 2px 0 0 var(--space);
  }
  .hk {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 12px;
    text-align: left;
  }
  .hk .p {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hk .a {
    color: var(--add);
  }
  .hk .d {
    color: var(--del);
  }
  .hk .n {
    color: var(--faint);
  }
  .grp {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bad {
    color: var(--del);
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  @media (max-width: 560px) {
    .scope {
      width: 80px;
    }
  }
</style>
