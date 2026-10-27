<script lang="ts">
  import AgentsView from "./components/AgentsView.svelte";
  import BottomHints from "./components/BottomHints.svelte";
  import FilesDrawer from "./components/FilesDrawer.svelte";
  import QuickOpen from "./components/QuickOpen.svelte";
  import CodeView from "./components/CodeView.svelte";
  import CommandBar from "./components/CommandBar.svelte";
  import CommitSheet from "./components/CommitSheet.svelte";
  import Composer from "./components/Composer.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";
  import SheetModal from "./components/SheetModal.svelte";
  import Island from "./components/Island.svelte";
  import Kbd from "./components/Kbd.svelte";
  import LinksSheet from "./components/LinksSheet.svelte";
  import NewSpaceSheet from "./components/NewSpaceSheet.svelte";
  import Rail from "./components/Rail.svelte";
  import ReviewView from "./components/ReviewView.svelte";
  import ShortcutsSheet from "./components/ShortcutsSheet.svelte";
  import StackPopover from "./components/StackPopover.svelte";
  import AgentSettings from "./components/AgentSettings.svelte";
  import Toast from "./components/Toast.svelte";
  import TopBar from "./components/TopBar.svelte";
  import { app } from "./lib/app.svelte";
  import { isTyping, resolveKey } from "./lib/keymap";
  import { isHttpUrl } from "./lib/links";
  import { installMenus, onGlobalContextMenu } from "./lib/menus";

  installMenus();

  // A URL pasted while no field has the focus is linked to the current space.
  function onPaste(e: ClipboardEvent) {
    if (!app.ready || !app.spaces.length || app.overlay || isTyping(e.target as HTMLElement | null)) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!isHttpUrl(text.trim()) || /\s/.test(text.trim())) return;
    e.preventDefault();
    void app.addLinkFromPaste(text);
  }

  function onKeydown(e: KeyboardEvent) {
    if (!app.ready) return;
    // With no space yet only the new space sheet takes keys (the button opens it).
    if (!app.spaces.length && app.overlay !== "newspace") return;
    const action = resolveKey(e, {
      typing: isTyping(e.target as HTMLElement | null),
      overlay: app.overlay,
      stackOpen: app.stackOpen,
      view: app.view,
      hasQuestion: app.spaces.length > 0 && !!app.sd.question,
      filesOpen: app.filesOpen,
      inFiles: !!(e.target as HTMLElement | null)?.closest?.("[data-files]"),
    });
    if (action) {
      e.preventDefault();
      void app.dispatch(action);
    }
  }

  // The accent of the whole window follows the active space.
  $effect(() => {
    if (app.ready && app.spaces.length) document.documentElement.style.setProperty("--space", app.space.color);
  });

  const surfaceKey = $derived(app.ready && app.spaces.length ? `${app.space.id}:${app.view}:${app.space.window ?? 1}` : "");
</script>

<svelte:window onkeydown={onKeydown} onpaste={onPaste} oncontextmenu={onGlobalContextMenu} />

{#if app.ready && !app.spaces.length}
  <main class="empty">
    <h1>{app.pinned ? "This space is gone" : "No space yet"}</h1>
    <p>
      {app.pinned
        ? "Close this window and pick another space."
        : "A space is one task: the repos it touches, one worktree each, and the agents working on it."}
    </p>
    {#if !app.pinned}
      <div class="emptyacts">
        <button class="btn p" onclick={() => app.dispatch({ type: "open-newspace" })}>Open repos in a space</button>
        <button class="btn" onclick={() => app.dispatch({ type: "open-newrepo" })}>Create a new repo</button>
      </div>
      <p class="small">Your repos under ~/Work are listed. Paste any other folder path in the repo filter.</p>
    {/if}
  </main>
  {#if app.overlay === "newspace"}<NewSpaceSheet />{/if}
  {#if app.overlay === "sheet"}<SheetModal />{/if}
  <ContextMenu />
  <Toast />
{:else if app.ready}
  <div class="app">
    <Rail />
    <div class="main" style:--termh={app.termOpen && !app.elsewhere ? `${app.termHeight + 8}px` : "0px"}>
      <TopBar />
      <div class="body">
        {#if app.filesOpen}<FilesDrawer />{/if}
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
              {#if app.view === "review"}<ReviewView />{:else if app.view === "code"}<CodeView />{:else if app.view === "prs"}{#await import("./components/PrsView.svelte") then { default: PrsView }}<PrsView />{/await}{:else}<AgentsView />{/if}
            </section>
          {/if}
        {/key}
      </div>
      {#if app.termOpen && !app.elsewhere}
        <!-- xterm.js is loaded the first time a terminal opens. -->
        {#await import("./components/TerminalPanel.svelte") then { default: TerminalPanel }}<TerminalPanel />{/await}
      {/if}
      {#if app.overlay !== "composer"}<Island />{/if}
      <BottomHints />
      {#if app.stackOpen}<StackPopover />{/if}
      {#if app.overlay === "composer"}<Composer />{/if}
    </div>
  </div>
  {#if app.overlay === "palette"}<CommandBar />{/if}
  {#if app.overlay === "quickopen"}<QuickOpen />{/if}
  {#if app.overlay === "newspace"}<NewSpaceSheet />{/if}
  {#if app.overlay === "commit"}<CommitSheet />{/if}
  {#if app.overlay === "links"}<LinksSheet />{/if}
  {#if app.overlay === "help"}<ShortcutsSheet />{/if}
  {#if app.overlay === "settings"}<AgentSettings />{/if}
  {#if app.overlay === "sheet"}<SheetModal />{/if}
  <ContextMenu />
  <Toast />
{/if}

<style>
  .empty {
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
  .emptyacts {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .empty .small {
    font-size: 12px;
    color: var(--faint);
  }
  .empty h1 {
    margin: 0;
    color: var(--fg);
    font-size: 20px;
  }
  .empty p {
    margin: 0;
    max-width: 420px;
  }
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
