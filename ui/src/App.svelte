<script lang="ts">
  import AgentsView from "./components/AgentsView.svelte";
  import BottomHints from "./components/BottomHints.svelte";
  import ChangesDrawer from "./components/ChangesDrawer.svelte";
  import CodeView from "./components/CodeView.svelte";
  import CommandBar from "./components/CommandBar.svelte";
  import CommitSheet from "./components/CommitSheet.svelte";
  import Composer from "./components/Composer.svelte";
  import Island from "./components/Island.svelte";
  import Kbd from "./components/Kbd.svelte";
  import NewSpaceSheet from "./components/NewSpaceSheet.svelte";
  import Rail from "./components/Rail.svelte";
  import ReviewView from "./components/ReviewView.svelte";
  import ShortcutsSheet from "./components/ShortcutsSheet.svelte";
  import StackPopover from "./components/StackPopover.svelte";
  import Toast from "./components/Toast.svelte";
  import TopBar from "./components/TopBar.svelte";
  import { app } from "./lib/app.svelte";
  import { isTyping, resolveKey } from "./lib/keymap";

  function onKeydown(e: KeyboardEvent) {
    if (!app.ready) return;
    const action = resolveKey(e, {
      typing: isTyping(e.target as HTMLElement | null),
      overlay: app.overlay,
      stackOpen: app.stackOpen,
      view: app.view,
      hasQuestion: !!app.sd.question,
    });
    if (action) {
      e.preventDefault();
      void app.dispatch(action);
    }
  }

  // The accent of the whole window follows the active space.
  $effect(() => {
    if (app.ready) document.documentElement.style.setProperty("--space", app.space.color);
  });

  const surfaceKey = $derived(app.ready ? `${app.space.id}:${app.view}:${app.space.window ?? 1}` : "");
</script>

<svelte:window onkeydown={onKeydown} />

{#if app.ready}
  <div class="app">
    <Rail />
    <div class="main">
      <TopBar />
      <div class="body">
        {#if app.changes}<ChangesDrawer />{/if}
        {#key surfaceKey}
          {#if app.elsewhere}
            <section class="surface enter">
              <div class="elsewhere">
                <span class="dot big" style:--c={app.space.color}></span>
                <h3>{app.space.name} is open in window {app.space.window}</h3>
                <p>Each window shows one space. Your other spaces stay here.</p>
                <button class="btn p" onclick={() => app.toggleWindow()}>Bring it to this window <Kbd k="W" /></button>
              </div>
            </section>
          {:else}
            <section class="surface enter" aria-label={app.view}>
              {#if app.view === "review"}<ReviewView />{:else if app.view === "code"}<CodeView />{:else}<AgentsView />{/if}
            </section>
          {/if}
        {/key}
      </div>
      {#if app.overlay !== "composer"}<Island />{/if}
      <BottomHints />
      {#if app.stackOpen}<StackPopover />{/if}
      {#if app.overlay === "composer"}<Composer />{/if}
    </div>
  </div>
  {#if app.overlay === "palette"}<CommandBar />{/if}
  {#if app.overlay === "newspace"}<NewSpaceSheet />{/if}
  {#if app.overlay === "commit"}<CommitSheet />{/if}
  {#if app.overlay === "help"}<ShortcutsSheet />{/if}
  <Toast />
{/if}

<style>
  .app {
    height: 100%;
    display: flex;
    gap: 8px;
    padding: 8px 16px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    position: relative;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 8px;
  }
  .surface {
    flex: 1;
    min-width: 0;
    background: var(--panel);
    border-radius: 16px;
    overflow: auto;
    position: relative;
    padding-bottom: 96px;
  }
  .surface.enter {
    animation: enter 320ms var(--ease);
  }
  .elsewhere {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--muted);
    text-align: center;
    padding: 24px;
  }
  .elsewhere h3 {
    margin: 0;
    color: var(--fg);
    font-size: 18px;
  }
  .elsewhere p {
    margin: 0;
  }
  .dot.big {
    width: 12px;
    height: 12px;
  }
  @media (max-width: 760px) {
    .app {
      flex-direction: column;
      height: auto;
      min-height: 100%;
    }
    .body {
      flex-direction: column;
      min-height: 70vh;
    }
  }
</style>
