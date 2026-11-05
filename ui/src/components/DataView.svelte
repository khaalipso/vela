<script lang="ts">
  // CSV / TSV as a table you can sort and filter, JSON / YAML as a tree you can fold and search.
  // Read-only: Ctrl S goes back to the source, where the file is edited.
  import {
    children,
    compareCells,
    kindOf,
    parseCsv,
    parseJson,
    parseYaml,
    pathString,
    sniffDelimiter,
    type DataKind,
    type Parsed,
  } from "../lib/datafile";
  import { writeClipboard } from "../lib/ops.svelte";

  let { text, kind, name }: { text: string; kind: DataKind; name: string } = $props();

  const LIMIT = 2000;
  let query = $state("");
  let shown = $state(LIMIT);

  // ---- CSV ----
  let header = $state(true);
  let sortCol = $state(-1);
  let sortDir = $state<1 | -1>(1);
  const delimiter = $derived(kind === "csv" ? sniffDelimiter(text, name) : ",");
  const grid = $derived(kind === "csv" ? parseCsv(text, delimiter) : []);
  const width = $derived(grid.reduce((n, r) => Math.max(n, r.length), 0));
  const cols = $derived(
    Array.from({ length: width }, (_, i) => (header && grid[0]?.[i]) || `Column ${i + 1}`),
  );
  const body = $derived(header ? grid.slice(1) : grid);
  const numeric = $derived(
    cols.map((_, c) => {
      const cells = body.slice(0, 200).map((r) => r[c] ?? "").filter((x) => x !== "");
      return cells.length > 0 && cells.every((x) => !Number.isNaN(Number(x)));
    }),
  );
  const rows = $derived.by(() => {
    const q = query.trim().toLowerCase();
    let list = body.map((r, i) => ({ r, n: i + 1 }));
    if (q) list = list.filter(({ r }) => r.some((c) => c.toLowerCase().includes(q)));
    if (sortCol >= 0) {
      const c = sortCol;
      list = [...list].sort((a, b) => sortDir * compareCells(a.r[c] ?? "", b.r[c] ?? ""));
    }
    return list;
  });
  function sortBy(c: number) {
    if (sortCol !== c) (sortCol = c), (sortDir = 1);
    else if (sortDir === 1) sortDir = -1;
    else sortCol = -1;
  }

  // ---- JSON / YAML ----
  let parsed = $state<Parsed | null>(null);
  $effect(() => {
    if (kind === "csv") return;
    const src = text;
    let stale = false;
    const done = kind === "json" ? Promise.resolve(parseJson(src)) : parseYaml(src).catch((e): Parsed => ({ ok: false, error: String(e?.message ?? e) }));
    void done.then((p) => {
      if (!stale) parsed = p;
    });
    return () => (stale = true);
  });

  /** Paths (joined with \u0000) of the folded nodes; the first two levels start open. */
  let folded = $state<Set<string>>(new Set());
  let touched = $state(false);
  type Row = { id: string; depth: number; key: string; index: boolean; path: string[]; idx: boolean[]; kind: ReturnType<typeof kindOf>; value: unknown; size: number; open: boolean; last: boolean };

  const SEP = "\u0000";
  function matches(key: string, v: unknown, q: string): boolean {
    if (key.toLowerCase().includes(q)) return true;
    return kindOf(v) !== "object" && kindOf(v) !== "array" && String(v).toLowerCase().includes(q);
  }
  /** Does this node, or something under it, match. */
  function hasMatch(key: string, v: unknown, q: string): boolean {
    return matches(key, v, q) || children(v).some(([k, c]) => hasMatch(k, c, q));
  }

  const tree = $derived.by(() => {
    if (!parsed || !parsed.ok) return { rows: [] as Row[], total: 0 };
    const q = query.trim().toLowerCase();
    const out: Row[] = [];
    let total = 0;
    const walk = (key: string, v: unknown, path: string[], idx: boolean[], depth: number, last: boolean) => {
      if (q && !hasMatch(key, v, q)) return;
      total++;
      const kids = children(v);
      const id = path.join(SEP);
      const open = kids.length > 0 && (q ? true : touched ? !folded.has(id) : depth < 2);
      if (out.length < shown) out.push({ id, depth, key, index: idx[idx.length - 1] ?? false, path, idx, kind: kindOf(v), value: v, size: kids.length, open, last });
      if (open) kids.forEach(([k, c], i) => walk(k, c, [...path, k], [...idx, Array.isArray(v)], depth + 1, i === kids.length - 1));
    };
    walk("", parsed.value, [], [], 0, true);
    return { rows: out, total };
  });

  function toggle(r: Row) {
    if (!r.size) return;
    if (!touched) {
      // Fold state starts as "first two levels open": make that explicit before the first change.
      touched = true;
      const f = new Set<string>();
      const mark = (v: unknown, path: string[], depth: number) => {
        const kids = children(v);
        if (kids.length && depth >= 2) f.add(path.join(SEP));
        kids.forEach(([k, c]) => mark(c, [...path, k], depth + 1));
      };
      if (parsed?.ok) mark(parsed.value, [], 0);
      folded = f;
    }
    const f = new Set(folded);
    if (f.has(r.id)) f.delete(r.id);
    else f.add(r.id);
    folded = f;
  }
  function foldAll(fold: boolean) {
    touched = true;
    const f = new Set<string>();
    if (fold && parsed?.ok) {
      const mark = (v: unknown, path: string[]) => {
        const kids = children(v);
        if (kids.length && path.length) f.add(path.join(SEP));
        kids.forEach(([k, c]) => mark(c, [...path, k]));
      };
      mark(parsed.value, []);
    }
    folded = f;
  }

  let copied = $state("");
  function copy(what: string, label: string) {
    void writeClipboard(what);
    copied = label;
    setTimeout(() => (copied = copied === label ? "" : copied), 1200);
  }
  const pretty = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
  const preview = (r: Row) =>
    r.kind === "array" ? `[${r.size}]` : r.kind === "object" ? `{${r.size}}` : r.kind === "string" ? JSON.stringify(r.value) : String(r.value ?? "null");

  // Fresh query and paging for another file.
  $effect(() => {
    void name;
    query = "";
    shown = LIMIT;
    sortCol = -1;
    touched = false;
    folded = new Set();
  });
</script>

<div class="data">
  <div class="bar">
    <input class="q" type="search" placeholder={kind === "csv" ? "Filter rows" : "Search keys and values"} bind:value={query} aria-label="Filter" />
    {#if kind === "csv"}
      <span class="stat">{rows.length}{query ? ` of ${body.length}` : ""} rows · {width} columns</span>
      <label class="chk"><input type="checkbox" bind:checked={header} /> Header row</label>
      <span class="sp"></span>
      <button class="btn" onclick={() => copy(rows.map(({ r }) => r.join("\t")).join("\n"), "rows")}>{copied === "rows" ? "Copied" : "Copy rows"}</button>
    {:else if parsed?.ok}
      <span class="stat">{tree.total} nodes{parsed.docs ? ` · ${parsed.docs} documents` : ""}</span>
      <span class="sp"></span>
      <button class="btn" onclick={() => foldAll(false)}>Expand all</button>
      <button class="btn" onclick={() => foldAll(true)}>Collapse all</button>
      <button class="btn" onclick={() => copy(JSON.stringify(parsed && parsed.ok ? parsed.value : null, null, 2), "all")}>{copied === "all" ? "Copied" : "Copy as JSON"}</button>
    {/if}
  </div>

  {#if kind === "csv"}
    {#if !grid.length}
      <p class="note">This file is empty.</p>
    {:else}
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th class="n">#</th>
              {#each cols as c, i}
                <th class:num={numeric[i]} aria-sort={sortCol === i ? (sortDir === 1 ? "ascending" : "descending") : "none"}>
                  <button onclick={() => sortBy(i)} title="Sort by {c}">
                    <span class="t">{c}</span><span class="arrow">{sortCol === i ? (sortDir === 1 ? "↑" : "↓") : ""}</span>
                  </button>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each rows.slice(0, shown) as { r, n } (n)}
              <tr>
                <td class="n">{n}</td>
                {#each cols as _, i}
                  <td class:num={numeric[i]} title={r[i] ?? ""} ondblclick={() => copy(r[i] ?? "", `c${n}.${i}`)}>{r[i] ?? ""}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
        {#if rows.length > shown}
          <button class="more" onclick={() => (shown += LIMIT)}>Show {Math.min(LIMIT, rows.length - shown)} more of {rows.length - shown} left</button>
        {/if}
      </div>
    {/if}
  {:else if !parsed}
    <p class="note">Reading…</p>
  {:else if !parsed.ok}
    <p class="note err">Not valid {kind === "json" ? "JSON" : "YAML"}: {parsed.error}</p>
    <p class="note">Ctrl S shows the source, where you can fix it.</p>
  {:else}
    <div class="scroll tree" role="tree">
      {#each tree.rows as r (r.id)}
        <div class="row" role="treeitem" aria-selected="false" aria-expanded={r.size ? r.open : undefined} style:padding-left="{12 + r.depth * 16}px">
          <button class="tw" class:none={!r.size} onclick={() => toggle(r)} aria-label={r.open ? "Fold" : "Unfold"}>{r.size ? (r.open ? "▾" : "▸") : ""}</button>
          {#if r.path.length}
            <button class="key" class:idx={r.index} title="Copy the path" onclick={() => copy(pathString(r.path, r.idx), "p" + r.id)}>{r.key}</button><span class="colon">:</span>
          {/if}
          {#if r.size && r.open}
            <span class="sum">{r.kind === "array" ? "[" : "{"}</span>
          {:else}
            <button class="val {r.kind}" title="Copy the value" onclick={() => copy(pretty(r.value), "v" + r.id)}>{preview(r)}</button>
          {/if}
          {#if copied === "p" + r.id}<span class="tip">path copied</span>{:else if copied === "v" + r.id}<span class="tip">copied</span>{/if}
        </div>
      {/each}
      {#if tree.total > tree.rows.length}
        <button class="more" onclick={() => (shown += LIMIT)}>Show more ({tree.total - tree.rows.length} left)</button>
      {/if}
      {#if !tree.total}<p class="note">Nothing matches “{query}”.</p>{/if}
    </div>
  {/if}
</div>

<style>
  .data {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    font-size: 13px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 16px;
    border-bottom: 1px solid var(--line);
    color: var(--faint);
    font-size: 12px;
  }
  .sp {
    flex: 1;
  }
  .q {
    width: 220px;
    padding: 4px 8px;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--fg);
    font: inherit;
  }
  .chk {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .scroll {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
  }
  table {
    border-collapse: separate;
    border-spacing: 0;
    font-family: var(--code);
    font-size: 12px;
    min-width: 100%;
  }
  th,
  td {
    padding: 4px 10px;
    border-right: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }
  th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--panel);
    padding: 0;
    font-family: inherit;
    font-weight: 600;
  }
  th button {
    all: unset;
    box-sizing: border-box;
    display: flex;
    gap: 6px;
    width: 100%;
    padding: 5px 10px;
    cursor: pointer;
    color: var(--fg);
  }
  th button:hover {
    background: var(--hover);
  }
  .arrow {
    color: var(--faint);
  }
  .num,
  th.num button {
    text-align: right;
    justify-content: flex-end;
  }
  td.n,
  th.n {
    position: sticky;
    left: 0;
    min-width: 44px;
    text-align: right;
    color: var(--faint);
    background: var(--panel);
    padding: 4px 8px;
  }
  th.n {
    z-index: 2;
  }
  tbody tr:hover td {
    background: var(--hover);
  }
  .tree {
    font-family: var(--code);
    font-size: 12.5px;
    padding: 6px 0;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 2px;
    line-height: 1.7;
    white-space: nowrap;
  }
  .row:hover {
    background: var(--hover);
  }
  .tw {
    all: unset;
    width: 16px;
    text-align: center;
    cursor: pointer;
    color: var(--faint);
  }
  .tw.none {
    cursor: default;
  }
  .key {
    all: unset;
    cursor: pointer;
    color: var(--fg);
    font-weight: 600;
  }
  .key.idx {
    color: var(--faint);
    font-weight: 400;
  }
  .colon {
    color: var(--faint);
    margin-right: 6px;
  }
  .val {
    all: unset;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 70ch;
  }
  .val.string {
    color: #5fae6b;
  }
  .val.number {
    color: #6aa6e8;
  }
  .val.boolean {
    color: #d9904a;
  }
  .val.null {
    color: var(--faint);
    font-style: italic;
  }
  .val.object,
  .val.array,
  .sum {
    color: var(--faint);
  }
  .tip {
    margin-left: 8px;
    font-size: 11px;
    color: var(--faint);
  }
  .more {
    all: unset;
    cursor: pointer;
    display: block;
    padding: 10px 16px;
    color: var(--faint);
    font-size: 12px;
  }
  .more:hover {
    color: var(--fg);
  }
  .note {
    padding: 12px 16px;
    color: var(--faint);
  }
  .err {
    color: #e5645a;
  }
</style>
