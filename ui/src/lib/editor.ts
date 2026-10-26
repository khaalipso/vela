// CodeMirror 6 setup for the code view: theme from the design tokens, pending proposals
// as block widgets above their position, a blue gutter mark on the lines you typed.

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import {
  Annotation,
  EditorState,
  Facet,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  drawSelection,
  gutter,
  highlightActiveLine,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { mount, unmount } from "svelte";
import InlineHunk from "../components/InlineHunk.svelte";
import type { FileContent } from "./backend";
import type { AgentRole, Hunk } from "./types";

/** Marks transactions that come from the backend, so they are not counted as your typing. */
export const External = Annotation.define<boolean>();

/** Number of the first line of the document in the real file. */
export const firstLineFacet = Facet.define<number, number>({ combine: (v) => v[0] ?? 1 });

// -- proposals as block widgets ----------------------------------------------

export interface HunkSpec {
  hunk: Hunk;
  role: AgentRole;
  tool: string;
  why: string;
}

export interface HunkSet {
  specs: HunkSpec[];
  focusId: string | null;
  onFocus: (id: string) => void;
}

class HunkWidget extends WidgetType {
  private comp: ReturnType<typeof mount> | null = null;
  constructor(
    readonly spec: HunkSpec,
    readonly focus: boolean,
    readonly onFocus: (id: string) => void,
  ) {
    super();
  }
  eq(o: HunkWidget): boolean {
    return (
      o.spec.hunk.id === this.spec.hunk.id &&
      o.focus === this.focus &&
      o.spec.why === this.spec.why &&
      JSON.stringify(o.spec.hunk.lines) === JSON.stringify(this.spec.hunk.lines)
    );
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-hunk";
    this.comp = mount(InlineHunk, {
      target: el,
      props: {
        hunk: this.spec.hunk,
        role: this.spec.role,
        tool: this.spec.tool,
        why: this.spec.why,
        focus: this.focus,
        onfocus: this.onFocus,
      },
    });
    return el;
  }
  destroy(): void {
    if (this.comp) void unmount(this.comp);
    this.comp = null;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** Where a hunk sits in the document: the line it starts at and how many lines it replaces. */
export function hunkDecorations(state: EditorState, set: HunkSet): DecorationSet {
  const doc = state.doc;
  const first = state.facet(firstLineFacet);
  const out: Range<Decoration>[] = [];
  let lastEnd = -1;
  const specs = [...set.specs].sort((a, b) => a.hunk.newStart - b.hunk.newStart);
  for (const spec of specs) {
    const w = new HunkWidget(spec, spec.hunk.id === set.focusId, set.onFocus);
    const ln = Math.max(1, spec.hunk.newStart - first + 1);
    if (ln > doc.lines) {
      out.push(Decoration.widget({ widget: w, block: true, side: 1 }).range(doc.length));
      continue;
    }
    const start = doc.line(ln);
    const del = spec.hunk.oldLines;
    if (del > 0 && start.from >= lastEnd) {
      const end = doc.line(Math.min(doc.lines, ln + del - 1));
      out.push(Decoration.replace({ widget: w, block: true }).range(start.from, end.to));
      lastEnd = end.to + 1;
    } else {
      out.push(Decoration.widget({ widget: w, block: true, side: -1 }).range(start.from));
    }
  }
  return Decoration.set(out, true);
}

export const setHunks = StateEffect.define<HunkSet>();

const hunkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setHunks)) value = hunkDecorations(tr.state, e.value);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// -- gutter mark on your lines -------------------------------------------------

class MineMarker extends GutterMarker {
  toDOM(): Node {
    return document.createTextNode("•");
  }
}
const mine = new MineMarker();

/** Replace the marks with these (1-based) line numbers. */
export const setMine = StateEffect.define<number[]>();

const mineField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMine)) {
        const lines = [...new Set(e.value)].filter((n) => n >= 1 && n <= tr.state.doc.lines).sort((a, b) => a - b);
        value = RangeSet.of(lines.map((n) => mine.range(tr.state.doc.line(n).from)));
      }
    }
    if (tr.docChanged && !tr.annotation(External)) {
      const add: Range<GutterMarker>[] = [];
      tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
        const a = tr.state.doc.lineAt(fromB).number;
        const b = tr.state.doc.lineAt(toB).number;
        for (let n = a; n <= b; n++) {
          const pos = tr.state.doc.line(n).from;
          let has = false;
          value.between(pos, pos, () => {
            has = true;
          });
          if (!has && !add.some((r) => r.from === pos)) add.push(mine.range(pos));
        }
      });
      if (add.length) value = value.update({ add, sort: true });
    }
    return value;
  },
});

// -- theme ---------------------------------------------------------------------

const theme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--fg)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--code)", lineHeight: "22px", overflowX: "auto" },
  ".cm-content": { caretColor: "var(--space)", padding: "0" },
  ".cm-line": { padding: "0 16px 0 12px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--space)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--space) 28%, transparent)",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--space) 9%, transparent)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--gutter)", border: "none", userSelect: "none" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "44px", padding: "0 0 0 0", textAlign: "right" },
  ".cm-mine-gutter": { width: "22px", paddingLeft: "12px" },
  ".cm-mine-gutter .cm-gutterElement": { color: "var(--info)", width: "10px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--space) 22%, transparent)" },
  ".cm-hunk": { fontFamily: "var(--ui)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "var(--info)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--add)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--warn)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-alt)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syn-alt)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--fg)" },
  { tag: [t.heading], color: "var(--fg)", fontWeight: "600" },
  { tag: [t.invalid], color: "var(--del)" },
]);

export function languageExt(l: FileContent["language"]): Extension {
  switch (l) {
    case "typescript":
      return javascript({ typescript: true });
    case "javascript":
      return javascript();
    case "rust":
      return rust();
    case "yaml":
      return yaml();
    case "sql":
      return sql();
    case "markdown":
      return markdown();
    default:
      return [];
  }
}

// -- state and helpers ---------------------------------------------------------

export function createState(f: FileContent, onUserChange: (content: string) => void): EditorState {
  return EditorState.create({
    doc: f.content,
    extensions: [
      firstLineFacet.of(f.firstLine),
      lineNumbers({ formatNumber: (n, s) => String(n + s.facet(firstLineFacet) - 1) }),
      gutter({ class: "cm-mine-gutter", markers: (v) => v.state.field(mineField), initialSpacer: () => mine }),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      languageExt(f.language),
      syntaxHighlighting(highlight),
      theme,
      hunkField,
      mineField,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) onUserChange(u.state.doc.toString());
      }),
    ],
  });
}

/** Replace the document with the smallest change, so the cursor and the marks stay put. */
export function replaceContent(view: EditorView, content: string): boolean {
  const cur = view.state.doc.toString();
  if (cur === content) return false;
  const n = Math.min(cur.length, content.length);
  let p = 0;
  while (p < n && cur[p] === content[p]) p++;
  let q = 0;
  while (q < n - p && cur[cur.length - 1 - q] === content[content.length - 1 - q]) q++;
  view.dispatch({
    changes: { from: p, to: cur.length - q, insert: content.slice(p, content.length - q) },
    annotations: External.of(true),
  });
  return true;
}

/** Put the cursor at the end of an (absolute) line number and focus the editor. */
export function focusLine(view: EditorView, absoluteLine: number): void {
  const n = Math.min(view.state.doc.lines, Math.max(1, absoluteLine - view.state.facet(firstLineFacet) + 1));
  const pos = view.state.doc.line(n).to;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "nearest" }) });
  view.focus();
}
