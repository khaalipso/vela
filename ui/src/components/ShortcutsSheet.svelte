<script lang="ts">
  import { app } from "../lib/app.svelte";
  import Kbd from "./Kbd.svelte";

  const groups: [string, [string, string][]][] = [
    [
      "Anywhere",
      [
        ["Ctrl T", "Spaces, files, actions"],
        ["Ctrl K", "Ask an agent (also @)"],
        ["Enter", "Do what is up next"],
        ["Shift Enter", "Next space waiting for you"],
        ["[  ]", "Previous, next space"],
        ["Alt 1 to 9", "Jump to space"],
        ["W", "Open space in its own window"],
        ["1  2  3  4", "Code, agents, review, git"],
        ["Ctrl ←  Ctrl →", "Previous, next view"],
        ["Ctrl Shift →  Ctrl Shift ←", "Older, more recent place: agents, files, pages (also the mouse buttons)"],
        ["B", "Files drawer"],
        ["Ctrl B", "Hide the spaces bar (it floats in on the left edge)"],
        ["Ctrl W", "Close the file tab shown in the editor"],
        ["Ctrl P", "Go to file"],
        ["/", "Filter files by name"],
        ["S", "Stack and containers"],
        ["@", "Ask an agent"],
        ["C", "Commit composer"],
        ["L", "Links of this space"],
        ["T  Ctrl `  Ctrl ↓", "Terminal panel"],
        ["Ctrl ↑", "Terminal on top (both can be open)"],
        ["Ctrl Shift `", "One more terminal"],
        ["Right click", "Actions of what is under the pointer"],
        ["Menu  Shift F10", "The same from the keyboard, on the focused item"],
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
        ["M", "Merge into one commit"],
        ["R", "Commit the next repo with staged changes"],
        ["O", "Conventional commits on or off"],
        ["[  ]", "Previous, next commit"],
        ["Enter", "Edit the subject"],
        ["Ctrl Enter", "Commit this repo, in order"],
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
        ["Ctrl F", "Find and replace in the file (Enter next, Shift Enter previous)"],
        ["Ctrl G", "Next match"],
        ["V", "Markdown: preview or source"],
      ],
    ],
    [
      "In the review",
      [
        ["J  K", "Next, previous file"],
        ["Space  Y", "Accept the file as the diff shows it, go to the next"],
        ["U", "Take an accepted file back to review"],
        ["Shift A", "Accept every file waiting (conflicts are left for you)"],
        ["N", "Reject what the agents propose in the file"],
        ["Tab  Shift Tab", "Next, previous change"],
        ["Enter", "Edit the result in the diff (Esc leaves)"],
        ["E", "Open the file in the editor"],
        ["M", "Comment the line (or click a line number)"],
        ["V", "Before and after side by side, or unified"],
        ["F", "Ask for a fix of the note on the file"],
        ["Shift Y", "Resolve the note"],
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
