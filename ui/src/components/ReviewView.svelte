<script lang="ts">
  import { app } from "../lib/app.svelte";
  import ChecksPanel from "./ChecksPanel.svelte";
  import ReviewDiff from "./ReviewDiff.svelte";
  import ReviewFiles from "./ReviewFiles.svelte";

  const MIN = 280;
  let root: HTMLDivElement | undefined = $state();

  // Drag the handle to resize the file column (never below 300 px, never over 60%).
  function drag(e: PointerEvent) {
    if (!root) return;
    e.preventDefault();
    const box = root.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      app.rvWidth = Math.round(Math.max(MIN, Math.min(box.width * 0.6, ev.clientX - box.left)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function nudge(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const cur = app.rvWidth || (root ? root.clientWidth * 0.34 : 400);
    app.rvWidth = Math.max(MIN, Math.round(cur + (e.key === "ArrowRight" ? 24 : -24)));
  }
</script>

<div class="wrap">
  <div class="rv" bind:this={root} style:--fw={app.rvWidth ? `${app.rvWidth}px` : "clamp(300px, 30%, 420px)"}>
    <div class="side">
      <ReviewFiles />
      <ChecksPanel />
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div class="handle" role="separator" aria-orientation="vertical" aria-label="Resize the file list" tabindex="0" onpointerdown={drag} onkeydown={nudge}></div>
    <ReviewDiff />
  </div>
</div>

<style>
  .wrap {
    height: 100%;
    container-type: inline-size;
  }
  /* Files and checks on the left, the diff takes the rest: it never gets squeezed. */
  .rv {
    height: 100%;
    display: grid;
    grid-template-columns: minmax(280px, var(--fw)) 6px minmax(0, 1fr);
    gap: 6px;
    padding: 12px;
    box-sizing: border-box;
  }
  .rv > :global(*) {
    min-height: 0;
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    min-height: 0;
  }
  .side > :global(.files) {
    flex: 1 1 auto;
    min-height: 120px;
  }
  .side > :global(.checks) {
    flex: 0 1 auto;
    max-height: 45%;
  }
  .handle {
    cursor: col-resize;
    border-radius: 3px;
    margin: 0 -2px;
  }
  .handle:hover,
  .handle:focus-visible {
    background: var(--line);
    outline: none;
  }
  /* Narrow: the list on top, the diff under it, each scrolling on its own. */
  @container (max-width: 760px) {
    .rv {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 42%) minmax(0, 1fr);
    }
    .handle {
      display: none;
    }
    .side > :global(.checks) {
      display: none;
    }
  }
</style>
