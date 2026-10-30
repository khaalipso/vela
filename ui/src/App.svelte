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
  import NewSpaceSheet from "./components/NewSpaceSheet.svelte";
  import Rail from "./components/Rail.svelte";
  import ReviewView from "./components/ReviewView.svelte";
  import ShortcutsSheet from "./components/ShortcutsSheet.svelte";
  import StackPopover from "./components/StackPopover.svelte";
  import AgentSettings from "./components/AgentSettings.svelte";
  import Toast from "./components/Toast.svelte";
  import TopBar from "./components/TopBar.svelte";
  import { untrack } from "svelte";
  import NavStrip from "./components/NavStrip.svelte";
  import FilePeek from "./components/FilePeek.svelte";
  import { app } from "./lib/app.svelte";
  import { isTyping, resolveKey } from "./lib/keymap";
  import { isHttpUrl } from "./lib/links";
  import SpacePage from "./components/SpacePage.svelte";
  import { installMenus, onGlobalContextMenu, selectedText } from "./lib/menus";
  import { writeClipboard } from "./lib/ops.svelte";

  installMenus();

  // A URL pasted while no field has the focus goes on the page of the current space.
  function onPaste(e: ClipboardEvent) {
    if (!app.ready || !app.spaces.length || app.overlay || isTyping(e.target as HTMLElement | null)) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!isHttpUrl(text.trim()) || /\s/.test(text.trim())) return;
    e.preventDefault();
    void app.addLinkFromPaste(text);
  }

  function onKeydown(e: KeyboardEvent) {
    if (!app.ready) return;
    // Ctrl C on text selected in the page (an answer, a command, an output): copy it ourselves,
    // so it works whatever the webview does with a selection that moves while an agent writes.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "c" || e.key === "C") && !isTyping(e.target as HTMLElement | null) && !(e.target as HTMLElement | null)?.closest?.(".xterm")) {
      const text = selectedText();
      if (text) {
        e.preventDefault();
        void writeClipboard(text);
        return;
      }
    }
    // With no space yet only the new space sheet takes keys (the button opens it).
    if (!app.spaces.length && app.overlay !== "newspace") return;
    const action = resolveKey(e, {
      typing: isTyping(e.target as HTMLElement | null),
      overlay: app.overlay,
      stackOpen: app.stackOpen,
      view: app.view,
      hasQuestion: app.spaces.length > 0 && !!app.sd.question,
      filesOpen: app.filesOpen && app.view === "code",
      inFiles: !!(e.target as HTMLElement | null)?.closest?.("[data-files]"),
      inTerm: !!(e.target as HTMLElement | null)?.closest?.(".xterm"),
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

  // Where you are is remembered for back and forward.
  $effect(() => {
    if (!app.ready || !app.spaces.length) return;
    const sid = app.space.id;
    const p = app.place;
    untrack(() => app.noteLocation(sid, p));
  });

  // Mouse back / forward buttons, as in a browser.
  function onMouse(e: MouseEvent) {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (e.type === "mouseup" && app.ready && app.spaces.length) void app.dispatch({ type: "nav", delta: e.button === 3 ? -1 : 1 });
  }

  const surfaceKey = $derived(app.ready && app.spaces.length ? `${app.space.id}:${app.view}:${app.space.window ?? 1}` : "");
</script>

<svelte:window onkeyup={(e) => (e.key === "Control" || e.key === "Shift" || e.key === "Meta") && app.hideNav()} onmouseup={onMouse} onmousedown={onMouse} onauxclick={onMouse} onkeydown={onKeydown} onpaste={onPaste} oncontextmenu={onGlobalContextMenu} />

{#if !app.ready}
  {#if app.bootError}
    <main class="empty">
      <h1>Vela could not load your spaces</h1>
      <p class="small">{app.bootError}</p>
      <div class="emptyacts"><button class="btn p" onclick={() => app.boot()}>Try again</button></div>
    </main>
  {:else}
    <main class="empty"><p class="small">Loading your spaces…</p></main>
  {/if}
{:else if !app.spaces.length}
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
{:else}
  <div class="app" class:norail={app.railOff}>
    {#if !app.railOff}
      <Rail />
    {:else if app.view !== "review"}
      <!-- The hidden spaces bar floats in while the pointer touches the left edge (never in the
           Review: its file list sits right there). -->
      <div class="edge" role="presentation" onmouseenter={() => (app.railPeek = true)}></div>
      {#if app.railPeek}<Rail floating />{/if}
    {/if}
    <div class="main">
      <TopBar />
      <div class="body">
        <!-- The Review view lists its own files: the tree would only take room there. -->
        {#if app.filesOpen && app.view === "code"}<FilesDrawer />{/if}
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
              {#if app.view === "review"}<ReviewView />{:else if app.view === "code"}<div class="panes"><CodeView pane="main" />{#if app.cui.split}<CodeView pane="split" />{/if}</div>{:else if app.view === "space"}<SpacePage />{:else if app.view === "prs"}{#await import("./components/GitView.svelte") then { default: GitView }}<GitView />{/await}{:else}<AgentsView />{/if}
            </section>
          {/if}
        {/key}
        <!-- The terminals float over the view, they never change its height. Both open: they share
             the whole height, and the limit between them can be dragged. xterm.js is loaded the
             first time one opens. A hidden panel stays mounted: its shells keep running. -->
        {#if app.termTopOpen || app.termOpen || app.terms.length}
          <div class="termlayer" class:both={app.termTopOpen && app.termOpen && !app.elsewhere} style:--split="{app.termSplit * 100}%">
            {#if app.termTopOpen || app.terms.some((t) => t.dock === "top")}
              {#await import("./components/TerminalPanel.svelte") then { default: TerminalPanel }}<TerminalPanel dock="top" />{/await}
            {/if}
            {#if app.termOpen || app.terms.some((t) => t.dock === "bottom")}
              {#await import("./components/TerminalPanel.svelte") then { default: TerminalPanel }}<TerminalPanel dock="bottom" />{/await}
            {/if}
          </div>
        {/if}
      </div>
      <!-- In the Review view the list already says what is next: the island only brings news. -->
      {#if app.overlay !== "composer" && app.view !== "agents" && !(app.view === "review" && ["review", "commit", "nothing"].includes(app.upNext.kind.type))}<Island />{/if}
      <BottomHints />
      {#if app.stackOpen}<StackPopover />{/if}
      {#if app.overlay === "composer"}<Composer />{/if}
    </div>
  </div>
  {#if app.overlay === "palette"}<CommandBar />{/if}
  {#if app.overlay === "quickopen"}<QuickOpen />{/if}
  {#if app.overlay === "newspace"}<NewSpaceSheet />{/if}
  {#if app.overlay === "commit"}<CommitSheet />{/if}
  {#if app.overlay === "help"}<ShortcutsSheet />{/if}
  {#if app.overlay === "settings"}<AgentSettings />{/if}
  {#if app.overlay === "filepeek"}<FilePeek />{/if}
  {#if app.navStrip}<NavStrip />{/if}
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
  .edge {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    width: 8px;
    z-index: 39;
  }
  .app.norail {
    padding-left: 12px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    position: relative;
  }
  /* The view keeps a third of the height when the terminals are open: they shrink first. */
  .body {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    gap: 8px;
    position: relative;
  }
  .termlayer {
    position: absolute;
    inset: 0;
    z-index: 15;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  }
  .termlayer > :global(.tp) {
    pointer-events: auto;
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
  /* The Review fills the height: its diff scrolls on its own. */
  .surface[aria-label="code"],
  .surface[aria-label="review"],
  .surface[aria-label="agents"] {
    padding-bottom: 0;
    overflow: hidden;
  }
  .panes {
    display: flex;
    height: 100%;
    min-height: 0;
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
