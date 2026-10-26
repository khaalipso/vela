<script lang="ts">
  import { app } from "../lib/app.svelte";
  import { GATE_NAMES, plural } from "../lib/format";
  import Kbd from "./Kbd.svelte";

  const g = $derived(app.gate);
  const files = $derived(app.staged);
  const repos = $derived(app.stagedRepos);
  const finished = $derived(!!g && g.checks.length >= GATE_NAMES.length);
  const fails = $derived(!!g && finished && !g.checks.every((c) => c.pass));
</script>

{#if g}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(e) => e.target === e.currentTarget && app.closeOverlay()}>
    <div class="sheet" role="dialog" aria-label="Commit gate">
      <div class="form">
        <div class="head">
          <span class="dot" style:--c={app.space.color}></span>
          <span class="ttl">Commit {app.space.name}</span>
          <span class="cost right">{files.length} files · {repos.join(", ")}</span>
        </div>
        <ul class="checks">
          {#each GATE_NAMES as name, i (name)}
            {@const c = g.checks[i]}
            {@const col = !c ? "var(--faint)" : c.pass ? "var(--add)" : "var(--del)"}
            <li>
              <span class="dot" class:pulse={!c} style:--c={col}></span>
              <span>{name}</span>
              <em style:--c={col}>{c ? c.detail : "checking"}</em>
            </li>
          {/each}
        </ul>
        <div class="cost">Reads the staged diff only, in parallel. Blocks already reviewed come from cache.</div>
        {#if app.pending.length}
          <div class="blocked">{app.pending.length} proposals are still unreviewed and will not be committed.</div>
        {/if}
        <div class="grp">
          <label for="msg-in">Message</label>
          <textarea class="field mono" id="msg-in" rows="4" bind:value={g.message}></textarea>
        </div>
        {#if fails}
          <div class="grp">
            <label for="ov-in" class="bad">Blocked. Fix it with F in review, or give a reason to override</label>
            <input class="field" id="ov-in" autocomplete="off" placeholder="Hotfix, tests are flaky on CI" bind:value={g.reason} />
          </div>
        {/if}
        <div class="actions">
          <button class="btn" onclick={() => app.closeOverlay()}>Cancel</button>
          <button class="btn p" disabled={!app.gateOk} onclick={() => app.doCommit()}>
            Commit and push {plural(repos.length, "repo", "repos")} <Kbd k="Ctrl Enter" />
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
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
</style>
