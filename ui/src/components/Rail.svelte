<script lang="ts">
  import { app } from "../lib/app.svelte";
  import { openAtEvent } from "../lib/contextmenu.svelte";
  import { plural } from "../lib/format";
  import { archivedMenu, spaceMenu } from "../lib/menus";
  import { ops } from "../lib/ops.svelte";
  import Kbd from "./Kbd.svelte";

  let { floating = false }: { floating?: boolean } = $props();
  let showArchived = $state(false);
</script>

<nav class="rail" class:floating aria-label="Spaces" onmouseleave={() => floating && (app.railPeek = false)}>
  <div class="brand">
    <svg width="20" height="20" viewBox="0 0 256 256" fill="none" stroke="var(--space)" stroke-width="18" stroke-linejoin="round" aria-hidden="true"
      ><path d="M128 28v172M128 40c40 30 64 76 64 140H128M120 64c-30 24-48 62-48 116h48" /><path d="M40 212h176" /></svg
    >
    Vela<small>Window 1</small>
    <button
      class="hide"
      title={app.railHidden ? "Keep the spaces bar open (Ctrl B)" : "Hide the spaces bar; it shows when the pointer touches the left edge (Ctrl B)"}
      aria-label={app.railHidden ? "Keep the spaces bar open" : "Hide the spaces bar"}
      onclick={() => app.dispatch({ type: "toggle-rail" })}
    >
      <svg width="16" height="16" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="32" y="48" width="192" height="160" rx="16" /><path d="M96 48v160" />
        {#if app.railHidden}<path d="M136 104l24 24-24 24" />{:else}<path d="M160 104l-24 24 24 24" />{/if}
      </svg>
    </button>
  </div>
  <button class="find" onclick={() => app.dispatch({ type: "open-palette" })}>
    <svg width="16" height="16" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" aria-hidden="true"
      ><circle cx="112" cy="112" r="72" /><path d="M163 163l53 53" /></svg
    >
    <span>Spaces, files, actions</span>
    <Kbd k="Ctrl T" />
  </button>
  <div class="label">Spaces</div>
  <div class="spaces">
    {#each app.spaces as sp, i (sp.id)}
      {@const w = app.waitingOf(i)}
      <button class="sp" aria-current={i === app.active} style:--c={sp.color} onclick={() => app.goSpace(i)} oncontextmenu={(e) => openAtEvent(e, spaceMenu(i), sp.name)}>
        <span class="dot"></span>
        <span class="nm">
          <b>{sp.name}</b>
          <i>{plural(sp.repos.length, "repo", "repos")} · {app.data[sp.id].agents.length} agents</i>
        </span>
        {#if sp.window != null}
          <span class="win">W{sp.window}</span>
        {:else if w}
          <span class="cnt">{w}</span>
        {/if}
        {#if i < 9}<Kbd k={`Alt ${i + 1}`} />{/if}
      </button>
    {/each}
  </div>
  <button class="newsp" onclick={() => app.dispatch({ type: "open-newspace" })}>
    <svg width="16" height="16" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" aria-hidden="true"
      ><path d="M128 48v160M48 128h160" /></svg
    >
    New space
  </button>
  {#if app.archived.length}
    <div class="arch">
      <button class="label archhead" aria-expanded={showArchived} onclick={() => (showArchived = !showArchived)}>
        <span class="chev" class:shut={!showArchived}>▾</span> Archived <span class="n">{app.archived.length}</span>
      </button>
      {#if showArchived}
        {#each app.archived as a (a.id)}
          <div class="ar" role="group" aria-label={a.name} oncontextmenu={(e) => openAtEvent(e, archivedMenu(a), a.name)}>
            <span class="dot" style:--c={a.color}></span>
            <span class="anm">{a.name}</span>
            <button class="restore" onclick={() => void ops.restore(a)}>Restore</button>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
  <div class="railfoot">
    <div><Kbd k="[" /><Kbd k="]" /> switch space</div>
    <div><Kbd k="Shift Enter" /> next space waiting</div>
    <div><Kbd k="W" /> open in its own window</div>
    <div><Kbd k="?" /> all shortcuts</div>
  </div>
</nav>

<style>
  .rail {
    width: 232px;
    flex: none;
    background: var(--rail);
    border-radius: 16px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    transition: background-color 400ms var(--ease);
    overflow-y: auto;
  }
  .rail.floating {
    position: fixed;
    top: 8px;
    bottom: 8px;
    left: 8px;
    z-index: 40;
    box-shadow:
      0 0 0 1px var(--line),
      0 24px 64px rgba(0, 0, 0, 0.45);
    animation: slidein 180ms var(--ease);
  }
  @keyframes slidein {
    from {
      transform: translateX(-24px);
      opacity: 0;
    }
  }
  .hide {
    margin-left: auto;
    color: var(--faint);
    display: inline-flex;
    padding: 4px;
    border-radius: 6px;
  }
  .hide:hover {
    color: var(--fg);
    background: var(--hover);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 0;
    font-weight: 600;
    font-size: 16px;
  }
  .brand small {
    margin-left: auto;
    font-size: 12px;
    font-weight: 500;
    color: var(--faint);
  }
  .find {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 10px;
    border-radius: 10px;
    background: var(--hover);
    color: var(--muted);
    font-size: 13px;
    transition: background-color 240ms var(--ease);
  }
  .find:hover {
    background: var(--line);
  }
  .find span {
    flex: 1;
    text-align: left;
  }
  .label {
    font-size: 12px;
    font-weight: 500;
    color: var(--faint);
    padding: 4px 8px 0;
    letter-spacing: 0.01em;
  }
  .spaces {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sp {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border-radius: 10px;
    text-align: left;
    transition: background-color 240ms var(--ease);
  }
  .sp:hover {
    background: color-mix(in srgb, var(--hover) 70%, transparent);
  }
  .sp[aria-current="true"] {
    background: var(--hover);
  }
  .nm {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .nm b {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .nm i {
    font-style: normal;
    font-size: 12px;
    color: var(--faint);
  }
  .cnt {
    font-size: 12px;
    font-weight: 600;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    background: var(--raised);
    color: var(--c);
  }
  .win {
    font-size: 11px;
    color: var(--faint);
    font-family: var(--code);
  }
  .newsp {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border-radius: 10px;
    color: var(--faint);
    transition: background-color 240ms var(--ease);
  }
  .newsp:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .arch {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .archhead {
    display: flex;
    align-items: center;
    gap: 6px;
    text-align: left;
  }
  .archhead .n {
    margin-left: auto;
    font-family: var(--code);
  }
  .chev {
    display: inline-block;
    transition: transform 200ms var(--ease);
  }
  .chev.shut {
    transform: rotate(-90deg);
  }
  .ar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 10px;
    color: var(--muted);
    font-size: 13px;
  }
  .ar:hover {
    background: color-mix(in srgb, var(--hover) 70%, transparent);
  }
  .anm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .restore {
    font-size: 12px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 6px;
    color: var(--fg);
    background: var(--hover);
  }
  .restore:hover {
    background: var(--line);
  }
  .arch + .railfoot {
    margin-top: 0;
  }
  .railfoot {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--panel) 60%, transparent);
    font-size: 12px;
    color: var(--faint);
  }
  .railfoot div {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  @media (max-width: 760px) {
    .rail {
      width: auto;
    }
    .spaces {
      flex-direction: row;
      overflow-x: auto;
    }
    .sp {
      flex: none;
    }
    .railfoot,
    .label {
      display: none;
    }
  }
</style>
