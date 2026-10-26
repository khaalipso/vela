<script lang="ts">
  import { tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { checkKey, flatChecks, formatDuration, shownStatus, STATUS_LABEL, summaryLine, verdict } from "../lib/checks";
  import { plural } from "../lib/format";
  import type { CheckStatus } from "../lib/types";
  import Kbd from "./Kbd.svelte";

  const COLOR: Record<CheckStatus, string> = {
    idle: "var(--faint)",
    running: "var(--info)",
    pass: "var(--add)",
    fail: "var(--del)",
    skipped: "var(--muted)",
    missing: "var(--warn)",
    disabled: "var(--faint)",
  };
  const repos = $derived(app.checkRepos.filter((r) => r.checks.length));
  const any = $derived(flatChecks(app.checkRepos).length > 0);
  const summary = $derived(summaryLine(app.checkRepos));
  const v = $derived(verdict(app.checkRepos));
  const stagedCount = $derived(app.sections.counts.staged);
  const open = $derived(app.rvs.open);
  const warnings = $derived(app.checkRepos.flatMap((r) => r.warnings ?? []));
  let logEl: HTMLElement | undefined = $state();

  const GATE: Record<string, string> = {
    pass: "Checks passed",
    fail: "A check is failing",
    running: "Checks running…",
    idle: "Checks have not run",
    none: "No checks enabled",
  };

  // Keep the end of a live log in view.
  $effect(() => {
    open;
    const lines = open ? app.logOf(...(open.split("/", 2) as [string, string])) : [];
    lines.length;
    void tick().then(() => {
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });
  });

  function click(c: (typeof repos)[number]["checks"][number]) {
    app.focusCheck(c);
    void app.rvToggleLog();
  }
  const logOf = (repo: string, id: string) => app.logOf(repo, id);
</script>

<aside class="checks" class:focused={app.rvs.focus === "checks"} aria-label="Checks">
  <header>
    <h3>Checks</h3>
    <button class="auto" role="switch" aria-checked={app.autoOn} disabled={!any} onclick={() => app.toggleAutoAll()} title="Run when the staged set changes">
      <i class="knob"></i>Auto
    </button>
    <button class="btn mini" disabled={!any} onclick={() => app.runChecks()}>Run <Kbd k="R" /></button>
  </header>
  <div class="summary" data-verdict={v}>
    <span class="dot" class:pulse={v === "running"} style:--c={v === "fail" ? "var(--del)" : v === "pass" ? "var(--add)" : v === "running" ? "var(--info)" : "var(--faint)"}></span>
    <span class="sum">{summary}</span>
  </div>

  {#if !any}
    <div class="empty">No hooks or tests found. Add one in <code>.vela/config.toml</code></div>
  {/if}

  <div class="list">
    {#each repos as r (r.repo)}
      {#if repos.length > 1}<div class="repo">{r.repo}</div>{/if}
      {#each r.checks as c (c.id)}
        {@const st = shownStatus(c)}
        {@const k = checkKey(c.repo, c.id)}
        <div class="check" class:focus={app.rvs.check === k} class:off={st === "disabled"} data-check={c.id} data-status={st}>
          <div class="row">
            <button class="main" aria-expanded={open === k} onclick={() => click(c)}>
              <span class="dot" class:pulse={st === "running"} class:hollow={st === "disabled"} style:--c={COLOR[st]}></span>
              <span class="name">{c.name}</span>
              <span class="kind">{c.kind}</span>
              <span class="meta">
                {#if st === "pass" || st === "fail"}
                  {formatDuration(c.durationMs)}{#if c.cached}<em class="cached">cached</em>{/if}
                {:else}
                  {STATUS_LABEL[st]}
                {/if}
              </span>
            </button>
            {#if c.optional}
              <button class="toggle" role="switch" aria-label="{c.name} {c.enabled ? 'on' : 'off'}" aria-checked={c.enabled} onclick={() => app.setCheckEnabled(c, !c.enabled)}>
                <i class="knob"></i>
              </button>
            {/if}
          </div>
          {#if open === k}
            <pre class="log" bind:this={logEl}>{#each logOf(c.repo, c.id) as line, i (i)}<span>{line}
</span>{:else}<span class="faint">{st === "running" ? "Waiting for output…" : "No output yet. Press R to run."}</span>{/each}</pre>
          {/if}
        </div>
      {/each}
    {/each}
  </div>
  {#if warnings.length}
    <div class="warn">{warnings.length} config {warnings.length === 1 ? "warning" : "warnings"}: {warnings[0]}</div>
  {/if}

  <footer class="commit">
    <div class="line"><b>{plural(stagedCount, "file", "files")}</b> staged</div>
    <div class="gate" data-verdict={v}>{GATE[v]}</div>
    <button class="btn p" disabled={!stagedCount} onclick={() => app.openCommit()}>Commit <Kbd k="C" /></button>
  </footer>
</aside>

<style>
  .checks {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    overflow: auto;
    padding: 2px 2px 12px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px 0;
  }
  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    flex: 1;
  }
  .summary {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 0 6px;
    font-size: 12.5px;
    color: var(--muted);
  }
  .auto,
  .toggle {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .auto:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .knob {
    width: 26px;
    height: 15px;
    border-radius: 9999px;
    background: var(--hover);
    position: relative;
    box-shadow: inset 0 0 0 1px var(--line);
    transition: background 200ms var(--ease);
  }
  .knob::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--muted);
    transition:
      transform 200ms var(--ease),
      background 200ms var(--ease);
  }
  [aria-checked="true"] .knob {
    background: color-mix(in srgb, var(--space) 40%, var(--hover));
  }
  [aria-checked="true"] .knob::after {
    transform: translateX(11px);
    background: var(--space);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: var(--raised);
    border-radius: 14px;
    padding: 6px;
  }
  .list:empty {
    display: none;
  }
  .repo {
    padding: 6px 8px 2px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--faint);
  }
  .check {
    border-radius: 10px;
  }
  .check.focus {
    box-shadow: 0 0 0 1px var(--space);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .main {
    all: unset;
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px;
    border-radius: 10px;
    cursor: pointer;
    font-size: 13px;
  }
  .main:hover {
    background: var(--hover);
  }
  .off .name {
    color: var(--muted);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kind {
    font-size: 11px;
    color: var(--faint);
    padding: 0 6px;
    border-radius: 9999px;
    background: var(--hover);
  }
  .meta {
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .cached {
    font-style: normal;
    font-size: 10.5px;
    padding: 0 5px;
    border-radius: 9999px;
    color: var(--info);
    box-shadow: inset 0 0 0 1px currentColor;
  }
  .toggle {
    padding-right: 6px;
  }
  .hollow {
    background: transparent !important;
    box-shadow: inset 0 0 0 1.5px var(--c);
  }
  .log {
    margin: 2px 6px 6px;
    padding: 8px 10px;
    max-height: 240px;
    overflow: auto;
    border-radius: 8px;
    background: var(--panel);
    font-family: var(--code);
    font-size: 11.5px;
    line-height: 1.5;
    white-space: pre;
    color: var(--muted);
  }
  .faint {
    color: var(--faint);
  }
  .empty {
    padding: 14px;
    border-radius: 14px;
    background: var(--raised);
    font-size: 13px;
    color: var(--muted);
  }
  code {
    font-family: var(--code);
    font-size: 12px;
  }
  .warn {
    font-size: 11.5px;
    color: var(--warn);
    padding: 0 8px;
  }
  .commit {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px;
    border-radius: 14px;
    background: var(--raised);
    font-size: 13px;
  }
  .gate {
    color: var(--muted);
    font-size: 12.5px;
  }
  .gate[data-verdict="fail"] {
    color: var(--del);
  }
  .gate[data-verdict="pass"] {
    color: var(--add);
  }
</style>
