<script lang="ts">
  import { app } from "../lib/app.svelte";
  import Kbd from "./Kbd.svelte";

  const groups: [string, [string, string][]][] = [
    [
      "Anywhere",
      [
        ["Ctrl K", "Spaces, files, actions"],
        ["Enter", "Do what is up next"],
        ["Shift Enter", "Next space waiting for you"],
        ["[  ]", "Previous, next space"],
        ["Alt 1 to 9", "Jump to space"],
        ["W", "Open space in its own window"],
        ["1  2  3", "Code, review, agents"],
        ["B", "Changes drawer"],
        ["S", "Stack and containers"],
        ["@", "Ask an agent"],
        ["C", "Commit composer"],
        ["L", "Links of this space"],
        ["?", "This sheet"],
      ],
    ],
    [
      "On a proposal",
      [
        ["J  K", "Next, previous"],
        ["Y", "Accept"],
        ["N", "Reject"],
        ["E", "Accept and edit by hand"],
        ["F", "Ask the author to fix the note"],
        ["U", "Undo"],
      ],
    ],
    [
      "In the commit composer",
      [
        ["T", "Cycle the type"],
        ["!", "Breaking change"],
        ["J  K", "Select a hunk"],
        ["1 to 9", "Move it to that commit"],
        ["G", "Hunk becomes a new commit"],
        ["M", "Merge into one commit per repo"],
        ["O", "Conventional commits on or off"],
        ["[  ]", "Previous, next commit"],
        ["Enter", "Edit the subject"],
        ["Ctrl Enter", "Commit all in order"],
      ],
    ],
    [
      "In the links sheet",
      [
        ["Paste", "Anywhere: link the URL to this space"],
        ["J  K", "Move"],
        ["Enter", "Open, or add the typed URL"],
        ["Backspace", "Remove a link you added"],
      ],
    ],
    [
      "In the editor",
      [
        ["Click", "Type anywhere, your lines get a blue mark"],
        ["Esc", "Leave the line, keys work again"],
      ],
    ],
  ];
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={(e) => e.target === e.currentTarget && app.closeOverlay()}>
  <div class="sheet wide" role="dialog" aria-label="Shortcuts">
    <div class="help">
      {#each groups as [title, rows] (title)}
        <h4>{title}</h4>
        {#each rows as [k, t] (k)}
          <div><span>{t}</span><Kbd {k} /></div>
        {/each}
      {/each}
    </div>
    <div class="pfoot"><span>In the desktop app these use Ctrl, here they are single keys like in Linear or Gmail</span></div>
  </div>
</div>

<style>
  .wide {
    max-width: 720px;
  }
  .help {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 4px 24px;
    padding: 16px;
  }
  h4 {
    grid-column: 1/-1;
    margin: 10px 0 2px;
    font-size: 12px;
    color: var(--faint);
    font-weight: 600;
  }
  .help div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 5px 0;
    font-size: 13px;
  }
</style>
