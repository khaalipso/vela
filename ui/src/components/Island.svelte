<script lang="ts">
  import { app } from "../lib/app.svelte";
  import Kbd from "./Kbd.svelte";

  const u = $derived(app.upNext);
</script>

<button class="island" class:quiet={u.quiet} aria-label={`Up next: ${u.title}`} onclick={() => app.upNextGo()}>
  <span class="dot"></span>
  <span class="tx"><b>{u.title}</b><span>{u.sub}</span></span>
  <span class="go">{u.go} <Kbd k={u.key} /></span>
</button>

<style>
  .island {
    position: absolute;
    left: 50%;
    bottom: calc(72px + var(--termh, 0px));
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: min(640px, calc(100% - 32px));
    padding: 10px 10px 10px 16px;
    border-radius: 9999px;
    background: var(--hover);
    box-shadow:
      0 12px 40px rgba(0, 0, 0, 0.35),
      0 0 0 1px var(--line);
    text-align: left;
    transition:
      transform 320ms var(--ease),
      background-color 240ms var(--ease);
  }
  .island:hover {
    background: var(--line);
  }
  .island .dot {
    background: var(--space);
  }
  .tx {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .tx b {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tx span {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .go {
    flex: none;
    height: 32px;
    padding: 0 12px;
    border-radius: 9999px;
    background: var(--space);
    color: var(--on-accent);
    font-weight: 600;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .quiet .go {
    background: var(--panel);
    color: var(--muted);
  }
  .quiet .dot {
    background: var(--faint);
  }
  @media (max-width: 760px) {
    .island {
      position: sticky;
      transform: none;
      left: auto;
      bottom: 8px;
      margin: 0 auto;
      max-width: 100%;
    }
  }
</style>
