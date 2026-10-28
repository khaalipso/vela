<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { app } from "../lib/app.svelte";
  import { languageOf } from "../lib/languages";
  import { createPane, type Pane } from "../lib/mergeview";

  interface Props {
    /** Identity of what is shown (space and file): another one rebuilds the editor. */
    id: string;
    path: string;
    before: string;
    after: string;
    split: boolean;
    editable: boolean;
    onChange: (doc: string) => void;
    onLine?: (line: number) => void;
  }
  let { id, path, before, after, split, editable, onChange, onLine }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  let pane: Pane | null = null;

  // Built again when the file, the layout or the "before" side changes; the "after" side is
  // updated in place so the cursor and the scroll stay where they are.
  $effect(() => {
    const el = host;
    const deps = [id, path, before, split, editable] as const;
    if (!el) return;
    untrack(() => {
      pane?.destroy();
      el.replaceChildren();
      pane = createPane({
        parent: el,
        before: deps[2],
        after,
        lang: languageOf(path),
        split: deps[3],
        editable: deps[4],
        onChange: (d) => onChange(d),
        onLine: (n) => onLine?.(n),
      });
      app.pane = pane;
    });
  });
  $effect(() => {
    const text = after;
    untrack(() => {
      if (pane && pane.doc() !== text) pane.setDoc(text);
    });
  });
  onDestroy(() => {
    pane?.destroy();
    if (app.pane === pane) app.pane = null;
    pane = null;
  });
</script>

<div class="pane" class:split bind:this={host}></div>

<style>
  .pane {
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  .pane :global(.cm-editor) {
    height: 100%;
  }
  .pane.split :global(.cm-mergeView) {
    height: 100%;
    overflow: auto;
  }
  .pane.split :global(.cm-mergeView .cm-editor) {
    height: auto;
  }
  .pane.split :global(.cm-mergeViewEditor) {
    min-width: 0;
  }
  .pane.split :global(.cm-merge-a) {
    border-right: 1px solid var(--line);
  }
</style>
