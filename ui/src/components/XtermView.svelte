<script lang="ts">
  // One terminal: xterm.js on the output of a shell started by the backend.
  import { FitAddon } from "@xterm/addon-fit";
  import { Terminal } from "@xterm/xterm";
  import "@xterm/xterm/css/xterm.css";
  import { onDestroy, onMount } from "svelte";
  import { app, type TermDock } from "../lib/app.svelte";

  let { id, active, dock = "bottom" }: { id: number; active: boolean; dock?: TermDock } = $props();
  let host: HTMLDivElement | undefined = $state();
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let detach: (() => void) | null = null;
  let ro: ResizeObserver | null = null;
  let handledFocus = 0;

  function css(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function resize() {
    if (!term || !fit || !host || !host.offsetParent) return;
    try {
      fit.fit();
      void app.backend.termResize(id, term.cols, term.rows).catch(() => {});
    } catch {
      // Not laid out yet.
    }
  }

  onMount(() => {
    if (!host) return;
    try {
      term = new Terminal({
        fontFamily: css("--code", "monospace"),
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
        theme: {
          background: css("--panel", "#181818"),
          foreground: css("--fg", "#ededed"),
          cursor: css("--space", "#e8a14a"),
          selectionBackground: "rgba(232, 161, 74, 0.3)",
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      term.onData((d) => void app.backend.termWrite(id, d).catch(() => {}));
      detach = app.attachTerm(id, (d) => term?.write(d));
      ro = new ResizeObserver(() => resize());
      ro.observe(host);
      resize();
      if (active) term.focus();
    } catch {
      // No canvas or layout (tests): the output still goes to the buffer of the store.
      term = null;
    }
  });

  onDestroy(() => {
    detach?.();
    ro?.disconnect();
    term?.dispose();
    term = null;
  });

  $effect(() => {
    const seq = app.termFocusSeq;
    if (active && seq !== handledFocus && app.termFocusDock === dock) {
      handledFocus = seq;
      queueMicrotask(() => {
        resize();
        term?.focus();
      });
    }
  });

  $effect(() => {
    if (active) queueMicrotask(resize);
  });
</script>

<div class="xt" class:hidden={!active} bind:this={host} data-term={id}></div>

<style>
  .xt {
    height: 100%;
    width: 100%;
    padding: 4px 0 0 8px;
    box-sizing: border-box;
  }
  .hidden {
    display: none;
  }
  .xt :global(.xterm-viewport) {
    background: transparent !important;
  }
</style>
