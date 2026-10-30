<script lang="ts">
  // A file named in an answer of an agent, in a mini page: what changed in it (the changes of
  // the agents and your own), and one click to open it in the code view or in the Review.
  import { app } from "../lib/app.svelte";
  import { fileKey } from "../lib/format";
  import { fileHunks } from "../lib/review";
  import DiffBlock from "./DiffBlock.svelte";
  import Kbd from "./Kbd.svelte";

  const peek = $derived(app.peek);
  const hunks = $derived(peek ? fileHunks(app.sd.hunks, peek.repo, peek.path) : []);
  const row = $derived(peek ? app.rows.find((r) => r.repo === peek.repo && r.path === peek.path) : undefined);
  const added = $derived(hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "add").length, 0));
  const removed = $derived(hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "del").length, 0));

  function openInCode(line?: number) {
    if (!peek) return;
    const key = fileKey(peek.repo, peek.path);
    app.closeOverlay();
    if (line) app.gotoLine(key, line);
    else app.openFile(app.active, key, true);
  }

  function openInReview() {
    if (!row) return;
    app.closeOverlay();
    app.setView("review");
    app.rvSelect(row.id);
  }

  function onkey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "e" || e.key === "E" || e.key === "Enter") {
      e.preventDefault();
      openInCode(hunks[0]?.newStart);
    } else if ((e.key === "r" || e.key === "R") && row) {
      e.preventDefault();
      openInReview();
    }
  }
</script>

<svelte:window onkeydown={onkey} />

{#if peek}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(e) => e.target === e.currentTarget && app.closeOverlay()}>
    <div class="sheet peek" role="dialog" aria-modal="true" aria-label="Changes of {peek.path}">
      <header>
        <div class="who">
          <b class="path">{peek.path}</b>
          <span class="repo">{peek.repo}</span>
        </div>
        {#if hunks.length}<span class="sz"><span class="a">+{added}</span> <span class="d">−{removed}</span></span>{/if}
        <span class="acts">
          {#if row}<button class="btn" onclick={openInReview}>Review <Kbd k="R" /></button>{/if}
          <button class="btn p" onclick={() => openInCode(hunks[0]?.newStart)}>Open in Code <Kbd k="E" /></button>
          <button class="x" aria-label="Close" title="Close (Esc)" onclick={() => app.closeOverlay()}>×</button>
        </span>
      </header>
      <div class="body">
        {#if hunks.length}
          {#each hunks as h (h.id)}
            <section class="hk">
              <div class="hh">
                <span class="loc">line {h.newStart}</span>
                {#if h.section}<span class="fn">{h.section}</span>{/if}
                <span class="st" class:staged={h.state === "staged"}>{h.state === "staged" ? "Staged" : "Not staged"}</span>
                <button class="btn ghost" onclick={() => openInCode(h.newStart)}>Go to line</button>
              </div>
              <DiffBlock hunk={h} />
            </section>
          {/each}
        {:else}
          <p class="none">No change waiting in this file. It may be committed already; open it to read it.</p>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    padding-top: 8vh;
  }
  .peek {
    max-width: 880px;
    max-height: 78vh;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px 12px 18px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .path {
    font-family: var(--code);
    font-size: 13.5px;
    overflow-wrap: anywhere;
  }
  .repo {
    color: var(--faint);
    font-size: 11.5px;
  }
  .sz {
    font-family: var(--code);
    font-size: 12px;
  }
  .a {
    color: var(--add);
  }
  .d {
    color: var(--del);
  }
  .acts {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .x {
    color: var(--faint);
    font-size: 18px;
    padding: 0 8px;
    border-radius: 6px;
  }
  .x:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .body {
    overflow-y: auto;
    padding: 10px 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 12px;
  }
  .hk {
    border-radius: 10px;
    background: var(--raised);
    overflow: hidden;
    box-shadow: 0 0 0 1px var(--line);
  }
  .hh {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
  }
  .fn {
    font-family: var(--code);
    color: var(--faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .st {
    margin-left: auto;
    color: var(--warn);
  }
  .st.staged {
    color: var(--add);
  }
  .hh .btn {
    height: 22px;
    font-size: 11.5px;
  }
  .none {
    margin: 12px 4px;
    color: var(--muted);
    font-size: 13px;
  }
</style>
