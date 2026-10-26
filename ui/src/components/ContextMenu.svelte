<script lang="ts">
  import { tick } from "svelte";
  import {
    clampToViewport,
    firstIndex,
    isDisabled,
    isItem,
    lastIndex,
    letterIndex,
    menu,
    nextIndex,
    placeSubmenu,
    type MenuAction,
    type MenuEntry,
  } from "../lib/contextmenu.svelte";
  import { ICONS } from "../lib/menuicons";
  import Kbd from "./Kbd.svelte";

  const m = $derived(menu.current);

  let root: HTMLDivElement | undefined = $state();
  let subEl: HTMLDivElement | undefined = $state();
  /** Highlighted entry of the main list, and of the submenu when one is open. */
  let active = $state(-1);
  let subOpen = $state(-1);
  let subActive = $state(-1);
  let pos = $state({ x: 0, y: 0 });
  let subPos = $state({ x: 0, y: 0 });
  let placed = $state(false);

  const entries = $derived(m?.entries ?? []);
  const subEntries = $derived<MenuEntry[]>(subOpen >= 0 ? ((entries[subOpen] as MenuAction | undefined)?.submenu ?? []) : []);

  // A new menu: reset the highlight, place it inside the viewport.
  $effect(() => {
    const cur = m;
    if (!cur) return;
    subOpen = -1;
    subActive = -1;
    placed = false;
    active = cur.keyboard ? firstIndex(cur.entries) : -1;
    pos = { x: cur.x, y: cur.y };
    void tick().then(() => {
      if (!root || menu.current !== cur) return;
      const r = root.getBoundingClientRect();
      pos = clampToViewport(cur.x, cur.y, r.width, r.height, window.innerWidth, window.innerHeight);
      placed = true;
      if (active < 0) root.focus({ preventScroll: true });
    });
  });

  // Submenu placement once it is rendered.
  $effect(() => {
    if (subOpen < 0 || !subEl || !root) return;
    const parent = root.querySelectorAll<HTMLElement>(':scope > .row > [role="menuitem"]')[itemOrdinal(subOpen)]?.getBoundingClientRect();
    const r = subEl.getBoundingClientRect();
    if (!parent) return;
    subPos = placeSubmenu(parent, r.width, r.height, window.innerWidth, window.innerHeight);
  });

  // The highlighted item has the focus, so screen readers follow.
  $effect(() => {
    const a = active;
    const sa = subActive;
    const so = subOpen;
    if (!root) return;
    void tick().then(() => {
      if (so >= 0 && sa >= 0) subEl?.querySelectorAll<HTMLElement>("button.item")[itemOrdinalIn(subEntries, sa)]?.focus({ preventScroll: true });
      else if (a >= 0) root?.querySelectorAll<HTMLElement>(':scope > .row > [role="menuitem"]')[itemOrdinal(a)]?.focus({ preventScroll: true });
    });
  });

  /** Position of entry `i` among the items only (separators have no button). */
  function itemOrdinalIn(list: MenuEntry[], i: number): number {
    return list.slice(0, i).filter(isItem).length;
  }
  const itemOrdinal = (i: number) => itemOrdinalIn(entries, i);

  // Closing: outside press, scroll, resize, the window losing focus.
  $effect(() => {
    if (!m) return;
    const inside = (t: EventTarget | null) => t instanceof Node && (root?.contains(t) || subEl?.contains(t));
    const down = (e: PointerEvent) => {
      if (!inside(e.target)) menu.close(true);
    };
    const away = (e: Event) => {
      if (!inside(e.target)) menu.close(true);
    };
    const gone = () => menu.close(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("wheel", away, { capture: true, passive: true });
    window.addEventListener("resize", gone);
    window.addEventListener("blur", gone);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("wheel", away, true);
      window.removeEventListener("resize", gone);
      window.removeEventListener("blur", gone);
      window.removeEventListener("keydown", onKey, true);
    };
  });

  function run(item: MenuAction) {
    if (isDisabled(item)) return;
    if (item.submenu) {
      openSub(entries.indexOf(item), true);
      return;
    }
    menu.close(true);
    item.run?.();
  }

  function openSub(i: number, focusFirst: boolean) {
    const it = entries[i];
    if (!it || !isItem(it) || !it.submenu || isDisabled(it)) return;
    active = i;
    subOpen = i;
    subActive = focusFirst ? firstIndex(it.submenu) : -1;
  }

  function closeSub() {
    const back = subOpen;
    subOpen = -1;
    subActive = -1;
    if (back >= 0) active = back;
  }

  function onKey(e: KeyboardEvent) {
    if (!menu.current) return;
    const k = e.key;
    // Every key belongs to the menu while it is open: nothing leaks to the shortcuts behind it.
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      return;
    }
    const inSub = subOpen >= 0 && subActive >= 0;
    const list = inSub ? subEntries : entries;
    const cur = inSub ? subActive : active;
    const set = (i: number) => (inSub ? (subActive = i) : (active = i));
    const handled = () => e.preventDefault();
    switch (k) {
      case "Escape":
        handled();
        if (inSub || subOpen >= 0) closeSub();
        else menu.close(true);
        return;
      case "ContextMenu":
        handled();
        menu.close(true);
        return;
      case "F10":
        handled();
        if (e.shiftKey) menu.close(true);
        return;
      case "ArrowDown":
        handled();
        return set(nextIndex(list, cur, 1));
      case "ArrowUp":
        handled();
        return set(nextIndex(list, cur, -1));
      case "Tab":
        handled();
        return set(nextIndex(list, cur, e.shiftKey ? -1 : 1));
      case "Home":
        handled();
        return set(firstIndex(list));
      case "End":
        handled();
        return set(lastIndex(list));
      case "ArrowRight": {
        handled();
        if (!inSub) openSub(active, true);
        return;
      }
      case "ArrowLeft":
        handled();
        if (subOpen >= 0) closeSub();
        return;
      case "Enter":
      case " ": {
        handled();
        const it = list[cur];
        if (it && isItem(it)) run(it);
        return;
      }
    }
    if (k.length === 1 && !e.shiftKey) {
      handled();
      const i = letterIndex(list, cur, k);
      if (i >= 0) set(i);
      return;
    }
    handled();
  }

  function hover(i: number) {
    const it = entries[i];
    if (!it || !isItem(it)) return;
    active = i;
    if (it.submenu && !isDisabled(it)) openSub(i, false);
    else {
      subOpen = -1;
      subActive = -1;
    }
  }
</script>

{#if m}
  <div
    class="ctxmenu"
    class:ready={placed}
    role="menu"
    aria-label={m.label}
    tabindex="-1"
    bind:this={root}
    style:left="{pos.x}px"
    style:top="{pos.y}px"
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#each entries as e, i (i)}
      {#if isItem(e)}
        <div class="row">
          <button
            type="button"
            class="item"
            class:danger={e.danger}
            class:on={i === active}
            role="menuitem"
            data-id={e.id}
            tabindex="-1"
            aria-disabled={isDisabled(e) || undefined}
            aria-haspopup={e.submenu ? "menu" : undefined}
            aria-expanded={e.submenu ? subOpen === i : undefined}
            title={typeof e.disabled === "string" ? e.disabled : undefined}
            onpointerenter={() => hover(i)}
            onclick={() => run(e)}
          >
            <span class="ic" aria-hidden="true">
              {#if e.swatch}
                <span class="sw" style:background={e.swatch}></span>
              {:else if e.checked}
                <svg width="14" height="14" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"><path d={ICONS.stage} /></svg>
              {:else if e.icon}
                <svg width="14" height="14" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"><path d={ICONS[e.icon]} /></svg>
              {/if}
            </span>
            <span class="lb">{e.label}</span>
            {#if e.submenu}
              <svg class="more" width="10" height="10" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M96 48l80 80-80 80" /></svg>
            {:else if e.shortcut}
              <Kbd k={e.shortcut} />
            {/if}
          </button>
          {#if e.submenu && subOpen === i}
            <div class="ctxmenu sub ready" role="menu" aria-label={e.label} bind:this={subEl} style:left="{subPos.x}px" style:top="{subPos.y}px">
              {#each subEntries as s, j (j)}
                {#if isItem(s)}
                  <button
                    type="button"
                    class="item"
                    class:danger={s.danger}
                    class:on={j === subActive}
                    role={s.checked === undefined ? "menuitem" : "menuitemradio"}
                    data-id={s.id}
                    tabindex="-1"
                    aria-disabled={isDisabled(s) || undefined}
                    aria-checked={s.checked === undefined ? undefined : s.checked}
                    title={typeof s.disabled === "string" ? s.disabled : undefined}
                    onpointerenter={() => (subActive = j)}
                    onclick={() => run(s)}
                  >
                    <span class="ic" aria-hidden="true">
                      {#if s.swatch}<span class="sw" style:background={s.swatch}></span>{/if}
                    </span>
                    <span class="lb">{s.label}</span>
                    {#if s.checked}
                      <svg class="more" width="12" height="12" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={ICONS.stage} /></svg>
                    {:else if s.shortcut}
                      <Kbd k={s.shortcut} />
                    {/if}
                  </button>
                {:else}
                  <div class="sep" role="separator"></div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="sep" role="separator"></div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .ctxmenu {
    position: fixed;
    z-index: 40;
    min-width: 220px;
    max-width: 340px;
    padding: 6px;
    border-radius: 12px;
    background: var(--panel);
    box-shadow:
      0 16px 48px rgba(0, 0, 0, 0.45),
      0 0 0 1px var(--line);
    outline: none;
    visibility: hidden;
  }
  .ctxmenu.ready {
    visibility: visible;
    animation: ctxin 120ms var(--ease);
    transform-origin: top left;
  }
  .ctxmenu.sub {
    position: fixed;
    z-index: 41;
  }
  .row {
    position: relative;
  }
  .item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px;
    border-radius: 8px;
    font-size: 13px;
    text-align: left;
    color: var(--fg);
    white-space: nowrap;
  }
  .item.on,
  .item:focus-visible {
    background: var(--hover);
    outline: none;
  }
  .item[aria-disabled="true"] {
    color: var(--faint);
    cursor: default;
  }
  .item.danger {
    color: var(--del);
  }
  .item.danger.on {
    background: var(--del-bg);
  }
  .ic {
    width: 16px;
    flex: none;
    display: inline-flex;
    justify-content: center;
    color: var(--muted);
  }
  .item.danger .ic {
    color: inherit;
  }
  .sw {
    width: 10px;
    height: 10px;
    border-radius: 9999px;
  }
  .lb {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .more {
    color: var(--faint);
    flex: none;
  }
  .sep {
    height: 1px;
    margin: 5px 6px;
    background: var(--line);
  }
  @keyframes ctxin {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ctxmenu.ready {
      animation: none;
    }
  }
</style>
