import type { Action } from "./keymap";
import type { Link } from "./types";

export interface PaletteItem {
  sec: "Actions" | "Here" | "Links" | "Spaces" | "Files";
  title: string;
  sub?: string;
  /** Color of the dot (a space color). */
  dot?: string;
  /** Shortcut shown on the right. */
  key?: string;
  /** What a key press or click dispatches. */
  action?: Action;
  /** Or a function, for the actions of the right-click menus. */
  run?: () => void;
}

export interface PaletteSource {
  /** Title of the current "Up next" island. */
  upNextTitle: string;
  /** Links of the current space; the ones with a URL can be opened from here. */
  links?: Link[];
  spaces: {
    name: string;
    branch: string;
    color: string;
    files: { id: string; repo: string; path: string }[];
  }[];
}

export function buildPaletteItems(src: PaletteSource): PaletteItem[] {
  const actions: [string, string, Action][] = [
    [`Up next: ${src.upNextTitle}`, "Enter", { type: "up-next" }],
    ["Go to review", "2", { type: "view", view: "review" }],
    ["Go to code", "1", { type: "view", view: "code" }],
    ["Go to agents", "3", { type: "view", view: "agents" }],
    ["Pull requests: reviews, comments, checks", "4", { type: "view", view: "prs" }],
    ["Ask an agent", "@", { type: "open-composer" }],
    ["Commit and push", "C", { type: "open-commit" }],
    ["Links of this space", "L", { type: "open-links" }],
    ["New space", "", { type: "open-newspace" }],
    ["New repo", "", { type: "open-newrepo" }],
    ["Add a repo to this space", "", { type: "open-addrepo" }],
    ["Open this space in its own window", "W", { type: "toggle-window" }],
    ["Toggle files", "B", { type: "toggle-files" }],
    ["Hide or show the spaces bar", "Ctrl B", { type: "toggle-rail" }],
    ["Go to file", "Ctrl P", { type: "quick-open" }],
    ["Show the stack", "S", { type: "open-stack" }],
    ["Terminal", "T", { type: "toggle-terminal" }],
    ["New terminal", "Ctrl Shift `", { type: "new-terminal" }],
    ["Find in file", "Ctrl F", { type: "find" }],
    ["Markdown preview or source", "V", { type: "toggle-preview" }],
    ["Agent tiers: model and effort per tool", "", { type: "open-settings" }],
    ["Agent prompts: edit the brief of each role", "", { type: "open-prompts" }],
    ["All shortcuts", "?", { type: "open-help" }],
  ];
  const items: PaletteItem[] = actions.map(([title, key, action]) => ({ sec: "Actions", title, key, action }));
  for (const l of src.links ?? []) {
    if (!l.url) continue;
    items.push({
      sec: "Links",
      title: `Open ${l.key && l.title === l.key ? l.key : l.title}`,
      sub: l.key && l.title !== l.key ? l.key : undefined,
      action: { type: "open-link", id: l.id },
    });
  }
  src.spaces.forEach((s, i) =>
    items.push({
      sec: "Spaces",
      title: s.name,
      sub: s.branch,
      dot: s.color,
      key: i < 9 ? `Alt ${i + 1}` : "",
      action: { type: "space-jump", index: i },
    }),
  );
  src.spaces.forEach((s, i) =>
    s.files.forEach((f) =>
      items.push({
        sec: "Files",
        title: f.path,
        sub: `${s.name} · ${f.repo}`,
        dot: s.color,
        action: { type: "open-file", space: i, file: f.id },
      }),
    ),
  );
  return items;
}

/** Every word of the query must appear somewhere in the title or the subtitle, in any order. */
export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return items;
  const words = q.split(/\s+/);
  return items.filter((x) => {
    const hay = `${x.title} ${x.sub ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
