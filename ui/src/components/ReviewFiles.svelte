<script lang="ts">
  // The files of the Review as a tree, like the files of a pull request: folders first, one
  // row per changed file with its state (to review, accepted, conflict, edited). "All files"
  // adds the files without changes, which open in the editor.
  import { tick } from "svelte";
  import { app, draftKey } from "../lib/app.svelte";
  import { colorOfRepo } from "../lib/colors";
  import { openAtEvent } from "../lib/contextmenu.svelte";
  import { allContainerIds, buildTree, flatten, naturalCompare, type FileEntry, type TNode } from "../lib/filetree";
  import { fileKey, ROLE_COLORS, roleLabel } from "../lib/format";
  import { reviewFileMenu } from "../lib/menus";
  import { rowId, type FileRow } from "../lib/review";
  import type { AgentRole } from "../lib/types";
  import Kbd from "./Kbd.svelte";

  const sections = $derived(app.sections);
  const selected = $derived(app.rvs.sel);
  const todo = $derived(sections.counts.review);
  const done = $derived(sections.counts.done);
  const all = $derived(todo + done);
  const sid = $derived(app.space.id);
  let root: HTMLElement | undefined = $state();
  let showAll = $state(readAll());
  let shut = $state<Record<string, boolean>>({});

  function readAll(): boolean {
    try {
      return localStorage.getItem("vela.rvAllFiles") === "1";
    } catch {
      return false;
    }
  }
  function setAll(v: boolean) {
    showAll = v;
    try {
      localStorage.setItem("vela.rvAllFiles", v ? "1" : "0");
    } catch {
      /* storage off */
    }
  }

  $effect(() => {
    selected;
    void tick().then(() => root?.querySelector<HTMLElement>("[data-sel='true']")?.scrollIntoView({ block: "nearest" }));
  });

  const rows = $derived([...sections.review, ...sections.done].flatMap((g) => g.files));
  const byId = $derived(new Map(rows.map((r) => [r.id, r])));
  const tree = $derived.by(() => {
    const repos = new Map<string, FileEntry[]>();
    const add = (repo: string, path: string) => {
      const list = repos.get(repo) ?? [];
      list.push({ repo, path, staged: null, unstaged: null });
      repos.set(repo, list);
    };
    for (const r of rows) add(r.repo, r.path);
    if (showAll) for (const f of app.sd.files) if (!byId.has(rowId(f.repo, f.path))) add(f.repo, f.path);
    const names = [...repos.keys()].sort(naturalCompare);
    return buildTree(names.map((repo) => ({ repo, branch: "", entries: repos.get(repo)! })));
  });
  const multiRepo = $derived(tree.length > 1);
  const flat = $derived.by(() => {
    const open = allContainerIds(tree);
    for (const id of Object.keys(shut)) if (shut[id]) open.delete(id);
    const list = flatten(tree, open);
    // One repo: its row says nothing the top bar does not.
    return multiRepo ? list : list.filter((x) => x.node.kind !== "repo").map((x) => ({ ...x, depth: x.depth - 1 }));
  });

  /** Files still to review under a folder. */
  function waitingIn(n: TNode): FileRow[] {
    if (n.kind === "file") {
      const r = byId.get(rowId(n.repo, n.path));
      return r && r.section === "review" ? [r] : [];
    }
    return n.children.flatMap(waitingIn);
  }
  const roleOf = (agent: string): AgentRole | null => app.sd.agents.find((a) => a.id === agent)?.role ?? null;
  const toggle = (id: string) => (shut = { ...shut, [id]: !shut[id] });
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
        <small>Ask an agent with <Kbd k="Ctrl K" />, or edit a file</small>
      </div>
    {/if}
  </div>

  <div class="tree">
    <div class="tools">
      <label class="check" title="Also list the files without changes; they open in the editor">
        <input type="checkbox" checked={showAll} onchange={(e) => setAll(e.currentTarget.checked)} />
        All files
      </label>
      <span class="grow"></span>
      {#if Object.values(shut).some(Boolean)}
        <button class="mini" onclick={() => (shut = {})}>Expand all</button>
      {:else if flat.some((x) => x.node.kind === "dir")}
        <button class="mini" onclick={() => (shut = Object.fromEntries([...allContainerIds(tree)].filter((id) => !id.startsWith("r:")).map((id) => [id, true])))}>Collapse all</button>
      {/if}
    </div>
    <div class="list">
      {#each flat as { node: n, depth } (n.id)}
        {#if n.kind !== "file"}
          {@const waiting = waitingIn(n)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="drow" class:repo={n.kind === "repo"} style:--d={depth} onclick={() => toggle(n.id)} title={n.path || n.repo}>
            <svg class="chev" class:shut={shut[n.id]} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
            {#if n.kind === "repo"}
              <b style:color={colorOfRepo(app.space, n.repo)}>{n.name}</b>
            {:else}
              <span class="dn">{n.name}</span>
            {/if}
            {#if waiting.length}
              <span class="cnt">{waiting.length}</span>
              <button class="ic ok" title={`Accept the ${waiting.length} files to review in this folder`} onclick={(e) => (e.stopPropagation(), void app.rvApproveRows(waiting))}>✓</button>
            {/if}
          </div>
        {:else}
          {@const r = byId.get(rowId(n.repo, n.path))}
          {#if !r}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="frow plain" style:--d={depth} title="No change: open in the editor" onclick={() => app.gotoLine(fileKey(n.repo, n.path), 1)}>
              <span class="st"></span><span class="nm">{n.name}</span>
            </div>
          {:else}
            {@const sec = r.section}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div
              class="frow"
              class:sel={r.id === selected}
              class:done={sec === "done"}
              style:--d={depth}
              data-row={r.id}
              data-sel={r.id === selected}
              data-section={sec}
              onclick={() => app.rvSelect(r.id)}
              oncontextmenu={(e) => {
                app.rvSelect(r.id);
                openAtEvent(e, reviewFileMenu(r), r.path);
              }}
            >
              <span class="st" data-letter={r.letter} title={sec === "done" ? "Accepted: staged, goes in the commit" : "To review"}>{sec === "done" ? "✓" : r.letter}</span>
              <span class="nm">{n.name}</span>
              <span class="who">
                {#each r.agents as a (a)}
                  {@const role = roleOf(a)}
                  <i class="chip" style:--c={role ? ROLE_COLORS[role] : "var(--warn)"} title={`Proposed by ${role ? roleLabel(role) : a}`}>{role ? roleLabel(role).slice(0, 3) : "AI"}</i>
                {/each}
                {#if r.mine}<i class="chip you" title="Your edits">You</i>{/if}
                {#if sec === "review" && app.conflictsLeft(sid, r)}<i class="chip cf" title="Conflicts with your edits: resolve them in the diff">Conflict</i>{:else if sec === "review" && app.rvDrafts[draftKey(sid, r.id)] !== undefined}<i class="chip ed" title="You edited the result in the diff">Edited</i>{/if}
              </span>
              <span class="n">
                {#if r.add}<i class="a">+{r.add}</i>{/if}
                {#if r.del}<i class="d">−{r.del}</i>{/if}
              </span>
              <span class="acts">
                {#if sec === "review"}
                  {#if r.agents.length}
                    <button class="ic no" title="Reject the agent's changes (N)" onclick={(e) => (e.stopPropagation(), void app.rvRejectRow(r))}>✕</button>
                  {/if}
                  <button class="ic ok" title="Accept file (Space)" onclick={(e) => (e.stopPropagation(), void app.rvStageRow(r))}>✓</button>
                {:else}
                  <button class="ic" title="Back to review (U)" onclick={(e) => (e.stopPropagation(), void app.rvStageRow(r))}>↶</button>
                {/if}
              </span>
            </div>
          {/if}
        {/if}
      {/each}
    </div>
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
  .tree {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--raised);
    border-radius: 14px;
    padding: 4px;
  }
  .tools {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 6px;
    font-size: 12px;
    color: var(--muted);
    border-bottom: 1px solid var(--line);
    margin-bottom: 4px;
  }
  .check {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
  }
  .check input {
    accent-color: var(--space);
    margin: 0;
  }
  .grow {
    flex: 1;
  }
  .mini {
    all: unset;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 6px;
  }
  .mini:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
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
  .drow,
  .frow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px 0 calc(8px + var(--d, 0) * 14px);
    border-radius: 8px;
    cursor: pointer;
    min-height: 30px;
    box-sizing: border-box;
    flex: none;
  }
  .drow {
    font-size: 12.5px;
    color: var(--muted);
  }
  .drow:hover,
  .frow:hover {
    background: var(--hover);
  }
  .drow.repo b {
    font-size: 13px;
  }
  .dn {
    font-family: var(--code);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    flex: none;
    transition: transform 200ms var(--ease);
  }
  .chev.shut {
    transform: rotate(-90deg);
  }
  .cnt {
    margin-left: auto;
    font-size: 11px;
    font-weight: 700;
    color: var(--warn);
    font-variant-numeric: tabular-nums;
  }
  .drow .ic {
    display: none;
  }
  .drow:hover .ic {
    display: grid;
  }
  .frow.sel {
    background: color-mix(in srgb, var(--space) 14%, var(--hover));
    box-shadow: inset 3px 0 0 var(--space);
  }
  .frow.done .nm,
  .frow.plain .nm {
    color: var(--muted);
  }
  .frow.plain {
    min-height: 26px;
  }
  .st {
    width: 14px;
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
  .nm {
    flex: 1;
    min-width: 0;
    font-family: var(--code);
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .plain .nm {
    font-weight: 400;
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
  .chip.cf {
    --c: var(--warn);
  }
  .chip.ed {
    --c: var(--info);
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
    width: 24px;
    height: 24px;
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
</style>
