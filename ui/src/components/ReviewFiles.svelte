<script lang="ts">
  import { colorOfRepo } from "../lib/colors";
  import { tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { openAtEvent } from "../lib/contextmenu.svelte";
  import { plural } from "../lib/format";
  import { reviewFileMenu } from "../lib/menus";
  import { SECTIONS, SECTION_TITLES, type FileRow, type RepoGroup, type Section } from "../lib/review";
  import Kbd from "./Kbd.svelte";

  const COLORS: Record<Section, string> = { staged: "var(--add)", unstaged: "var(--info)", proposed: "var(--warn)" };
  const sections = $derived(app.sections);
  const selected = $derived(app.rvs.sel);
  let root: HTMLElement | undefined = $state();

  const split = (path: string): [string, string] => {
    const i = path.lastIndexOf("/");
    return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
  };
  const groups = (sec: Section): RepoGroup[] => sections[sec];
  const todo = $derived(sections.counts.unstaged + sections.counts.proposed);

  $effect(() => {
    selected;
    void tick().then(() => root?.querySelector<HTMLElement>("[data-sel='true']")?.scrollIntoView({ block: "nearest" }));
  });

  function pick(r: FileRow) {
    app.rvSelect(r.id);
  }
</script>

<section class="files" bind:this={root} aria-label="Files">
  {#if todo}
    <div class="bar">
      <div class="left">
        <b>{todo} {todo === 1 ? "change" : "changes"} to review</b>
        <span>{sections.counts.staged} staged</span>
      </div>
      <button class="btn p all" onclick={() => void app.rvApproveAll()} title="Stage your edits and accept every proposal">
        ✓ Approve all <Kbd k="Shift A" />
      </button>
    </div>
  {:else if sections.counts.staged}
    <div class="bar done">
      <div class="left">
        <b>All reviewed</b>
        <span>{sections.counts.staged} {sections.counts.staged === 1 ? "file" : "files"} staged</span>
      </div>
      <button class="btn p all" onclick={() => app.dispatch({ type: "open-commit" })}>Commit <Kbd k="C" /></button>
    </div>
  {/if}
  <div class="list">
  {#each SECTIONS as sec (sec)}
    {@const n = sections.counts[sec]}
    {@const collapsed = app.rvs.collapsed[sec]}
    <div class="sec" class:big={sec === "staged"} data-section={sec}>
      <div class="shw">
        <button class="sh" aria-expanded={!collapsed} onclick={() => app.rvToggleSection(sec)}>
          <span class="chev" class:shut={collapsed}>▾</span>
          <span class="dot" style:--c={COLORS[sec]}></span>
          <b>{SECTION_TITLES[sec]}</b>
          <span class="count">{n}</span>
          {#if sec === "staged" && n}
            <span class="tot"><i class="a">+{sections.total.add}</i> <i class="d">−{sections.total.del}</i></span>
          {/if}
        </button>
        {#if n}
          {#if sec === "staged"}
            <button class="sa" onclick={() => void app.rvUnstageAll()} title="Unstage every file (Shift U)">Unstage all</button>
          {:else if sec === "unstaged"}
            <button class="sa" onclick={() => void app.rvStageAll()} title="Stage every file of yours">Stage all</button>
          {:else}
            <button class="sa" onclick={() => void app.rvAcceptAll()} title="Accept every proposal">Accept all</button>
          {/if}
        {/if}
      </div>
      {#if !collapsed}
        {#if !n}
          <div class="empty">
            {#if sec === "staged"}
              Nothing staged. Stage with <Kbd k="Space" /> or <Kbd k="Y" />
            {:else if sec === "unstaged"}
              No edits of yours waiting
            {:else}
              No proposals from agents
            {/if}
          </div>
        {/if}
        {#each groups(sec) as g (g.repo)}
          <div class="repo" style:--rc={colorOfRepo(app.space, g.repo)}><b><i class="rdot"></i>{g.repo}</b><span>{plural(g.files.length, "file", "files")}</span></div>
          {#each g.files as r (r.id)}
            {@const [dir, name] = split(r.path)}
            <button
              class="frow"
              class:sel={r.id === selected}
              data-row={r.id}
              data-sel={r.id === selected}
              tabindex="-1"
              style:--c={COLORS[sec]}
              onclick={() => pick(r)}
              oncontextmenu={(e) => {
                pick(r);
                openAtEvent(e, reviewFileMenu(r), r.path);
              }}
            >
              <span class="st">{r.letter}</span>
              <span class="pt"><em>{dir}</em>{name}</span>
              <span class="n">
                {#if r.add || r.del}<i class="a">+{r.add}</i> <i class="d">−{r.del}</i>{/if}
              </span>
              <span
                class="go"
                role="button"
                tabindex="-1"
                title={sec === "staged" ? "Unstage" : sec === "proposed" ? "Accept" : "Stage"}
                onclick={(e) => {
                  e.stopPropagation();
                  void app.rvStageRow(r);
                }}
                onkeydown={() => {}}>{sec === "staged" ? "−" : "✓"}</span
              >
            </button>
          {/each}
        {/each}
      {/if}
    </div>
  {/each}
  </div>
  <div class="tips">
    <span><Kbd k="J" /><Kbd k="K" /> move</span>
    <span><Kbd k="Space" /> stage file</span>
    <span><Kbd k="Tab" /> next hunk</span>
    <span><Kbd k="Y" /> accept</span>
    <span><Kbd k="M" /> comment</span>
    <span><Kbd k="Shift U" /> unstage all</span>
  </div>
</section>

<style>
  .files {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    padding: 4px 2px 0;
  }
  .list {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 10px 10px 14px;
    border-radius: 14px;
    background: color-mix(in srgb, var(--space) 12%, var(--panel));
    flex: none;
    flex-wrap: wrap;
  }
  .bar.done {
    background: color-mix(in srgb, var(--add) 12%, var(--panel));
  }
  .bar .left {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-width: 0;
  }
  .bar b {
    font-size: 14px;
    font-weight: 600;
  }
  .bar span {
    font-size: 12px;
    color: var(--muted);
  }
  .bar .all {
    flex: none;
  }
  .shw {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .sa {
    all: unset;
    flex: none;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    padding: 4px 9px;
    border-radius: 8px;
    margin-right: 4px;
  }
  .sa:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .go {
    flex: none;
    width: 24px;
    height: 24px;
    margin: -3px -4px -3px 0;
    border-radius: 7px;
    display: grid;
    place-items: center;
    font-family: var(--ui);
    font-weight: 700;
    color: var(--c);
    background: color-mix(in srgb, var(--c) 14%, transparent);
    opacity: 0;
    transition: opacity 120ms var(--ease);
  }
  .frow:hover .go,
  .frow.sel .go {
    opacity: 1;
  }
  .go:hover {
    background: color-mix(in srgb, var(--c) 28%, transparent);
  }
  .sec {
    background: var(--raised);
    border-radius: 14px;
    padding: 4px;
    flex: none;
  }
  .sec.big {
    padding-bottom: 8px;
  }
  .sh {
    all: unset;
    box-sizing: border-box;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    cursor: pointer;
    font-size: 13px;
    border-radius: 10px;
    color: var(--muted);
  }
  .sec.big .sh {
    font-size: 14px;
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
  .empty {
    padding: 10px 14px 12px;
    font-size: 13px;
    color: var(--faint);
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .repo b {
    font-weight: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: color-mix(in srgb, var(--rc) 75%, var(--faint));
  }
  .rdot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--rc);
  }
  .repo {
    display: flex;
    justify-content: space-between;
    padding: 8px 12px 2px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--faint);
  }
  .frow {
    all: unset;
    box-sizing: border-box;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 9px;
    cursor: pointer;
    font-family: var(--code);
    font-size: 13.5px;
    color: var(--fg);
  }
  .frow:hover {
    background: var(--hover);
  }
  .frow.sel {
    background: var(--hover);
    box-shadow: inset 2px 0 0 var(--space);
  }
  .st {
    width: 14px;
    text-align: center;
    font-weight: 600;
    color: var(--c);
    flex: none;
  }
  .pt {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .pt em {
    font-style: normal;
    color: var(--faint);
  }
  .n {
    flex: none;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .tips {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 6px 10px;
    font-size: 11.5px;
    color: var(--faint);
  }
</style>
