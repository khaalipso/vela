<script lang="ts">
  import { tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { colorOfRepo } from "../lib/colors";
  import { openAtEvent } from "../lib/contextmenu.svelte";
  import { ROLE_COLORS, roleLabel } from "../lib/format";
  import { reviewFileMenu } from "../lib/menus";
  import type { FileRow, Section } from "../lib/review";
  import type { AgentRole } from "../lib/types";
  import Kbd from "./Kbd.svelte";

  const sections = $derived(app.sections);
  const selected = $derived(app.rvs.sel);
  const todo = $derived(sections.counts.review);
  const done = $derived(sections.counts.done);
  const all = $derived(todo + done);
  const multiRepo = $derived(app.space.repos.length > 1);
  let root: HTMLElement | undefined = $state();

  $effect(() => {
    selected;
    void tick().then(() => root?.querySelector<HTMLElement>("[data-sel='true']")?.scrollIntoView({ block: "nearest" }));
  });

  const split = (path: string): [string, string] => {
    const i = path.lastIndexOf("/");
    return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
  };
  const roleOf = (agent: string): AgentRole | null => app.sd.agents.find((a) => a.id === agent)?.role ?? null;
  const rowsOf = (sec: Section): FileRow[] => sections[sec].flatMap((g) => g.files);
</script>

<section class="files" bind:this={root} aria-label="Files">
  <div class="head">
    {#if todo}
      <div class="what">
        <b>{todo} {todo === 1 ? "file" : "files"} to review</b>
        <span class="bar"><i style:width={`${(done / Math.max(1, all)) * 100}%`}></i></span>
        <small>{done} of {all} accepted</small>
      </div>
      <button class="btn p" onclick={() => void app.rvApproveAll()} title="Accept every file waiting (Shift A)">Accept all</button>
    {:else if done}
      <div class="what">
        <b>All accepted</b>
        <span class="bar"><i style:width="100%"></i></span>
        <small>{done} {done === 1 ? "file" : "files"} ready to commit</small>
      </div>
      <button class="btn p" onclick={() => app.dispatch({ type: "open-commit" })}>Commit <Kbd k="C" /></button>
    {:else}
      <div class="what">
        <b>No changes</b>
        <small>Ask an agent with <Kbd k="@" />, or edit a file</small>
      </div>
    {/if}
  </div>

  <div class="list">
    {#each ["review", "done"] as const as sec (sec)}
      {@const list = rowsOf(sec)}
      {@const collapsed = app.rvs.collapsed[sec]}
      {#if list.length}
        <div class="sec" data-section={sec}>
          <button class="sh" aria-expanded={!collapsed} onclick={() => app.rvToggleSection(sec)}>
            <span class="chev" class:shut={collapsed}>▾</span>
            <b>{sec === "review" ? "To review" : "Accepted"}</b>
            <span class="count">{list.length}</span>
            {#if sec === "done" && (sections.total.add || sections.total.del)}<span class="tot"><i class="a">+{sections.total.add}</i> <i class="d">−{sections.total.del}</i></span>{/if}
          </button>
          {#if !collapsed}
            {#each list as r (r.id)}
              {@const [dir, name] = split(r.path)}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div
                class="frow"
                class:sel={r.id === selected}
                class:done={sec === "done"}
                data-row={r.id}
                data-sel={r.id === selected}
                onclick={() => app.rvSelect(r.id)}
                oncontextmenu={(e) => {
                  app.rvSelect(r.id);
                  openAtEvent(e, reviewFileMenu(r), r.path);
                }}
              >
                <span class="st" data-letter={r.letter}>{sec === "done" ? "✓" : r.letter}</span>
                <span class="pt">
                  <span class="nm">{name}</span>
                  {#if multiRepo || dir}
                    <span class="dir">
                      {#if multiRepo}<b style:color={colorOfRepo(app.space, r.repo)}>{r.repo}</b>{#if dir}&nbsp;·&nbsp;{/if}{/if}<span class="dp">{dir.replace(/\/$/, "")}</span>
                    </span>
                  {/if}
                </span>
                <span class="who">
                  {#each r.agents as a (a)}
                    {@const role = roleOf(a)}
                    <i class="chip" style:--c={role ? ROLE_COLORS[role] : "var(--warn)"} title={`Proposed by ${role ? roleLabel(role) : a}`}>{role ? roleLabel(role).slice(0, 3) : "AI"}</i>
                  {/each}
                  {#if r.mine}<i class="chip you" title="Your edits">You</i>{/if}
                </span>
                <span class="n">
                  {#if r.add}<i class="a">+{r.add}</i>{/if}
                  {#if r.del}<i class="d">−{r.del}</i>{/if}
                </span>
                <span class="acts">
                  {#if sec === "review"}
                    {#if r.agents.length}
                      <button class="ic no" title="Reject the agent's changes" onclick={(e) => (e.stopPropagation(), void app.rvRejectRow(r))}>✕</button>
                    {/if}
                    <button class="ic ok" title="Accept file (Space)" onclick={(e) => (e.stopPropagation(), void app.rvStageRow(r))}>✓</button>
                  {:else}
                    <button class="ic" title="Back to review (Space)" onclick={(e) => (e.stopPropagation(), void app.rvStageRow(r))}>↶</button>
                  {/if}
                </span>
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    {/each}
  </div>
  <div class="tips">
    <span><Kbd k="J" /><Kbd k="K" /> file</span>
    <span><Kbd k="Space" /> accept</span>
    <span><Kbd k="Shift A" /> all</span>
    <span><Kbd k="M" /> comment</span>
  </div>
</section>

<style>
  .files {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 12px 12px 14px;
    border-radius: 14px;
    background: var(--raised);
  }
  .what {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .what b {
    font-size: 15px;
    font-weight: 600;
  }
  .what small {
    font-size: 12px;
    color: var(--muted);
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .bar {
    height: 4px;
    border-radius: 9999px;
    background: var(--hover);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--add);
    border-radius: inherit;
    transition: width 300ms var(--ease);
  }
  .head .btn {
    flex: none;
  }
  .list {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sec {
    background: var(--raised);
    border-radius: 14px;
    padding: 4px;
    flex: none;
  }
  .sh {
    all: unset;
    box-sizing: border-box;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    cursor: pointer;
    font-size: 13px;
    border-radius: 10px;
    color: var(--muted);
  }
  .sh:hover {
    background: var(--hover);
  }
  .sh b {
    color: var(--fg);
    font-weight: 600;
  }
  .chev {
    font-size: 10px;
    width: 10px;
    transition: transform 200ms var(--ease);
  }
  .chev.shut {
    transform: rotate(-90deg);
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
  .tot {
    margin-left: auto;
    font-family: var(--code);
    font-size: 12px;
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
  .frow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px 7px 10px;
    border-radius: 10px;
    cursor: pointer;
    min-height: 40px;
    box-sizing: border-box;
  }
  .frow:hover {
    background: var(--hover);
  }
  .frow.sel {
    background: color-mix(in srgb, var(--space) 14%, var(--hover));
    box-shadow: inset 3px 0 0 var(--space);
  }
  .frow.done .nm {
    color: var(--muted);
  }
  .st {
    width: 18px;
    flex: none;
    text-align: center;
    font-family: var(--code);
    font-size: 12px;
    font-weight: 700;
    color: var(--info);
  }
  .st[data-letter="A"] {
    color: var(--add);
  }
  .st[data-letter="D"] {
    color: var(--del);
  }
  .done .st {
    color: var(--add);
  }
  .pt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.25;
  }
  .nm {
    font-family: var(--code);
    font-size: 13.5px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dir {
    display: flex;
    min-width: 0;
    font-family: var(--code);
    font-size: 11.5px;
    color: var(--faint);
    white-space: nowrap;
  }
  .dir b {
    flex: none;
    font-weight: 600;
  }
  /* The end of a long folder path matters most: cut it on the left. */
  .dp {
    unicode-bidi: plaintext;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: left;
  }
  .who {
    flex: none;
    display: flex;
    gap: 3px;
  }
  .chip {
    font-size: 10.5px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 9999px;
    color: var(--c);
    background: color-mix(in srgb, var(--c) 15%, transparent);
  }
  .chip.you {
    --c: var(--muted);
  }
  .n {
    flex: none;
    display: flex;
    gap: 5px;
    font-family: var(--code);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .acts {
    flex: none;
    display: none;
    gap: 2px;
  }
  .frow:hover .acts,
  .frow.sel .acts {
    display: flex;
  }
  .frow:hover .n,
  .frow.sel .n {
    display: none;
  }
  .ic {
    all: unset;
    cursor: pointer;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    display: grid;
    place-items: center;
    font-weight: 700;
    color: var(--muted);
  }
  .ic:hover {
    background: var(--line);
    color: var(--fg);
  }
  .ic.ok {
    color: var(--add);
    background: color-mix(in srgb, var(--add) 15%, transparent);
  }
  .ic.ok:hover {
    background: color-mix(in srgb, var(--add) 28%, transparent);
  }
  .ic.no:hover {
    color: var(--del);
  }
  .tips {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 2px 10px 4px;
    font-size: 11.5px;
    color: var(--faint);
  }
</style>
