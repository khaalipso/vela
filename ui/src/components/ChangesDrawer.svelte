<script lang="ts">
  import { app } from "../lib/app.svelte";
  import { fileKey, uniq } from "../lib/format";
  import type { ChangeKind } from "../lib/types";

  const letter: Record<ChangeKind, string> = {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
    untracked: "U",
    conflicted: "C",
  };

  interface Row {
    repo: string;
    path: string;
    st: string;
  }
  const groups = $derived<[string, Row[], string][]>([
    [
      "Staged",
      app.sd.status.filter((c) => c.staged).map((c) => ({ repo: c.repo, path: c.path, st: letter[c.staged!] })),
      "var(--add)",
    ],
    [
      "Changed by you",
      app.sd.status.filter((c) => c.unstaged).map((c) => ({ repo: c.repo, path: c.path, st: letter[c.unstaged!] })),
      "var(--info)",
    ],
    [
      "Proposed by agents",
      uniq(app.pending.map((p) => fileKey(p.hunk.repo, p.hunk.path))).map((k) => {
        const i = k.indexOf("/");
        return { repo: k.slice(0, i), path: k.slice(i + 1), st: "P" };
      }),
      "var(--warn)",
    ],
  ]);
</script>

<aside class="changes" aria-label="Changes">
  {#each groups as [title, rows, color] (title)}
    <div class="grp">
      <h3>{title}<span>{rows.length}</span></h3>
      {#if !rows.length}<div class="empty">Nothing here</div>{/if}
      {#each rows as f (f.repo + "/" + f.path)}
        <button class="frow" style:--c={color} onclick={() => app.openFile(app.active, fileKey(f.repo, f.path))}>
          <span class="rp">{f.repo}</span><span class="pt">{f.path}</span><span class="st">{f.st}</span>
        </button>
      {/each}
    </div>
  {/each}
</aside>

<style>
  .changes {
    width: 280px;
    flex: none;
    background: var(--panel);
    border-radius: 16px;
    padding: 12px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    animation: enter 320ms var(--ease);
  }
  h3 {
    margin: 0 0 4px;
    padding: 0 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    display: flex;
    justify-content: space-between;
  }
  h3 span {
    color: var(--faint);
    font-weight: 500;
  }
  .frow {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px;
    border-radius: 8px;
    font-size: 12px;
    text-align: left;
    transition: background-color 200ms var(--ease);
  }
  .frow:hover {
    background: var(--hover);
  }
  .rp {
    font-size: 11px;
    color: var(--faint);
    padding: 0 5px;
    border-radius: 4px;
    background: var(--raised);
  }
  .pt {
    flex: 1;
    min-width: 0;
    font-family: var(--code);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .st {
    font-family: var(--code);
    font-weight: 600;
    color: var(--c);
  }
  @media (max-width: 760px) {
    .changes {
      width: auto;
    }
  }
</style>
