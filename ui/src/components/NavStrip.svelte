<script lang="ts">
  // The places you went through, scrolling by while you move with Ctrl Shift arrows or the mouse
  // buttons: most recent on the left, oldest on the right. Each card says where (file, Page,
  // Review, Git, agent), in which space, and for an agent the title of the conversation.
  import { tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { basename, dirname } from "../lib/ops.svelte";
  import { ROLE_COLORS, roleLabel, toolLabel } from "../lib/format";
  import type { Place } from "../lib/navhist";

  const strip = $derived(app.navStrip);
  let row: HTMLElement | undefined = $state();

  const VIEW_NAME: Record<string, string> = { space: "Page", review: "Review", prs: "Git", code: "Code", agents: "Agents" };

  function card(p: Place): { title: string; sub: string; kind: string; color?: string } {
    if (p.view === "code" && p.file) {
      const [repo, ...rest] = p.file.split("/");
      const path = rest.join("/");
      return { title: basename(path) || p.file, sub: [repo, dirname(path)].filter(Boolean).join(" · "), kind: "File" };
    }
    if (p.view === "agents" && p.agent) {
      const a = app.sd.agents.find((x) => x.id === p.agent);
      if (a) {
        const t = (a.title || a.prompt || a.summary || "").trim();
        return { title: t.length > 70 ? `${t.slice(0, 70)}…` : t || "Conversation", sub: `${roleLabel(a.role)} · ${toolLabel(a.tool)}`, kind: "Agent", color: ROLE_COLORS[a.role] };
      }
      return { title: "Agent", sub: "", kind: "Agent" };
    }
    return { title: VIEW_NAME[p.view] ?? p.view, sub: app.space.name, kind: "Space" };
  }

  $effect(() => {
    void strip?.at;
    void tick().then(() => row?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }));
  });
</script>

{#if strip}
  <div class="nav" role="status" aria-label="Places you went through">
    <div class="row" bind:this={row}>
      {#each strip.places as p, i (i)}
        {@const c = card(p)}
        <div class="card" class:on={i === strip.at} aria-current={i === strip.at} style:--rc={c.color ?? "var(--space, var(--info))"}>
          <small>{c.kind}{#if i === 0} · most recent{/if}</small>
          <b>{c.title}</b>
          {#if c.sub}<span>{c.sub}</span>{/if}
        </div>
      {/each}
    </div>
    <p class="hint">Ctrl Shift → older · ← more recent</p>
  </div>
{/if}

<style>
  .nav {
    position: fixed;
    left: 50%;
    bottom: 56px;
    transform: translateX(-50%);
    z-index: 40;
    max-width: min(920px, calc(100vw - 32px));
    padding: 12px;
    border-radius: 18px;
    background: var(--panel);
    box-shadow:
      0 24px 80px rgba(0, 0, 0, 0.5),
      0 0 0 1px var(--line);
    animation: pop 200ms var(--ease);
    pointer-events: none;
  }
  .row {
    display: flex;
    gap: 8px;
    overflow: hidden;
  }
  .card {
    flex: 0 0 180px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--raised);
    opacity: 0.55;
    transform: scale(0.94);
    transition:
      opacity 160ms var(--ease),
      transform 160ms var(--ease);
    min-width: 0;
  }
  .card.on {
    opacity: 1;
    transform: none;
    box-shadow: 0 0 0 2px var(--rc);
  }
  small {
    color: var(--rc);
    font-size: 11px;
  }
  b {
    font-size: 13px;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow-wrap: anywhere;
  }
  span {
    color: var(--faint);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    margin: 8px 2px 0;
    font-size: 11px;
    color: var(--faint);
    text-align: center;
  }
</style>
