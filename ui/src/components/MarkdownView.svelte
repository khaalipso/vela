<script lang="ts">
  // Rendered Markdown of the open file, with its own find bar (Ctrl F). V shows the source.
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import { tick, untrack } from "svelte";
  import { isHttpUrl } from "../lib/links";

  let {
    text,
    findSeq = 0,
    onopenurl,
    onopenfile,
  }: {
    text: string;
    findSeq?: number;
    onopenurl: (url: string) => void;
    /** A relative link to another file of the repo. */
    onopenfile: (path: string) => void;
  } = $props();

  let root: HTMLElement | undefined = $state();
  let input: HTMLInputElement | undefined = $state();
  let finding = $state(false);
  let query = $state("");
  let hits = $state(0);
  let at = $state(0);
  let handled = 0;

  const html = $derived(DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }) as string));

  function clearMarks() {
    if (!root) return;
    for (const m of [...root.querySelectorAll("mark.find")]) {
      m.replaceWith(document.createTextNode(m.textContent ?? ""));
    }
    root.normalize();
  }

  function highlight() {
    clearMarks();
    hits = 0;
    const q = query.toLowerCase();
    if (!root || !q) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const t = node.data;
      let i = t.toLowerCase().indexOf(q);
      if (i < 0) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      while (i >= 0) {
        frag.append(t.slice(last, i));
        const m = document.createElement("mark");
        m.className = "find";
        m.textContent = t.slice(i, i + q.length);
        frag.append(m);
        hits++;
        last = i + q.length;
        i = t.toLowerCase().indexOf(q, last);
      }
      frag.append(t.slice(last));
      node.replaceWith(frag);
    }
    at = hits ? Math.min(at, hits - 1) : 0;
    show();
  }

  function show() {
    const marks = root ? [...root.querySelectorAll<HTMLElement>("mark.find")] : [];
    marks.forEach((m, i) => m.classList.toggle("cur", i === at));
    marks[at]?.scrollIntoView?.({ block: "center" });
  }

  function step(d: 1 | -1) {
    if (!hits) return;
    at = (at + d + hits) % hits;
    show();
  }

  async function openFind() {
    finding = true;
    await tick();
    input?.focus();
    input?.select();
  }

  function closeFind() {
    finding = false;
    query = "";
    clearMarks();
    hits = 0;
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
    }
  }

  function onclick(e: MouseEvent) {
    const a = (e.target as HTMLElement | null)?.closest?.("a");
    const href = a?.getAttribute("href");
    if (!a || !href) return;
    e.preventDefault();
    if (isHttpUrl(href)) onopenurl(href);
    else if (!href.startsWith("#") && !/^[a-z]+:/i.test(href)) onopenfile(href.split("#")[0]);
    else if (href.startsWith("#")) root?.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView();
  }

  $effect(() => {
    if (findSeq !== handled) {
      handled = findSeq;
      if (findSeq) void openFind();
    }
  });

  // The find marks change this DOM, so it is written by hand, not by Svelte.
  $effect(() => {
    if (!root) return;
    root.innerHTML = html;
    untrack(() => {
      if (finding && query) highlight();
    });
  });
</script>

{#if finding}
  <div class="find" role="search">
    <input bind:this={input} bind:value={query} oninput={() => ((at = 0), highlight())} onkeydown={onkey} placeholder="Find" aria-label="Find in the preview" />
    <span class="count">{query ? (hits ? `${at + 1} of ${hits}` : "No match") : ""}</span>
    <button class="btn" onclick={() => step(-1)} aria-label="Previous match">↑</button>
    <button class="btn" onclick={() => step(1)} aria-label="Next match">↓</button>
    <button class="x" onclick={closeFind} aria-label="Close find">×</button>
  </div>
{/if}
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article class="md" bind:this={root} {onclick}></article>

<style>
  .find {
    position: sticky;
    top: var(--find-top, 46px);
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    font-size: 12px;
  }
  .find input {
    background: var(--raised);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 3px 8px;
    outline: none;
    font: inherit;
    width: 220px;
  }
  .find input:focus {
    border-color: var(--space);
  }
  .count {
    color: var(--muted);
    min-width: 64px;
  }
  .x {
    color: var(--faint);
    font-size: 16px;
    padding: 0 6px;
  }
  .md {
    max-width: 820px;
    margin: 0 auto;
    padding: 16px 32px 48px;
    line-height: 1.65;
    font-size: 14px;
    color: var(--fg);
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    line-height: 1.3;
    margin: 1.6em 0 0.6em;
  }
  .md :global(h1) {
    font-size: 26px;
  }
  .md :global(h2) {
    font-size: 20px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--line);
  }
  .md :global(h3) {
    font-size: 16px;
  }
  .md :global(:first-child) {
    margin-top: 0;
  }
  .md :global(a) {
    color: var(--info);
    text-decoration: none;
  }
  .md :global(a:hover) {
    text-decoration: underline;
  }
  .md :global(code) {
    font-family: var(--code);
    font-size: 12.5px;
    background: var(--raised);
    border-radius: 4px;
    padding: 1px 5px;
  }
  .md :global(pre) {
    background: var(--raised);
    border-radius: 10px;
    padding: 12px 14px;
    overflow-x: auto;
  }
  .md :global(pre code) {
    background: none;
    padding: 0;
  }
  .md :global(blockquote) {
    margin: 0;
    padding: 0 14px;
    border-left: 3px solid var(--line);
    color: var(--muted);
  }
  .md :global(table) {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
  }
  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--line);
    padding: 5px 10px;
    text-align: left;
  }
  .md :global(th) {
    background: var(--raised);
  }
  .md :global(img) {
    max-width: 100%;
  }
  .md :global(hr) {
    border: none;
    border-top: 1px solid var(--line);
  }
  .md :global(mark.find) {
    background: color-mix(in srgb, var(--warn) 30%, transparent);
    color: inherit;
    border-radius: 2px;
  }
  .md :global(mark.find.cur) {
    background: color-mix(in srgb, var(--warn) 65%, transparent);
  }
</style>
