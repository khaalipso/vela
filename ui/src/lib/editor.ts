// CodeMirror 6 setup for the code view: theme from the design tokens, pending proposals
// as block widgets above their position, a blue gutter mark on the lines you typed.

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import {
  Annotation,
  Compartment,
  EditorState,
  Facet,
  Prec,
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
import { loadLanguage, type Lang } from "./languages";
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

// -- change bars: your changes in the gutter, staged or not ---------------------

export type ChangeKind = "add" | "mod" | "del";
export type ChangeState = "staged" | "unstaged";

/** One line of the document with a change of yours (1-based document line). */
export interface ChangeMark {
  line: number;
  kind: ChangeKind;
  state: ChangeState;
  /** The hunk it belongs to; null for lines typed since the last refresh. */
  hunkId: string | null;
}

class ChangeMarker extends GutterMarker {
  constructor(
    readonly kind: ChangeKind,
    readonly state: ChangeState,
    readonly hunkId: string | null,
  ) {
    super();
  }
  eq(o: ChangeMarker): boolean {
    return o.kind === this.kind && o.state === this.state && o.hunkId === this.hunkId;
  }
  toDOM(): Node {
    const el = document.createElement("div");
    el.className = `cm-chg cm-chg-${this.kind} cm-chg-${this.state}`;
    el.title = `${this.state === "staged" ? "Staged" : "Not staged"} ${this.kind === "add" ? "addition" : this.kind === "del" ? "deletion" : "change"}: click to see it, stage it or revert it`;
    return el;
  }
}
const spacer = new ChangeMarker("mod", "unstaged", null);

/** The change bars of the hunks of yours in this file, line by line. Unstaged wins on a line. */
export function changeMarks(
  hunks: { id: string; state: string; newStart: number; newLines: number; oldLines: number; lines: { kind: string }[] }[],
  firstLine: number,
  docLines: number,
): ChangeMark[] {
  const byLine = new Map<number, ChangeMark>();
  const sorted = [...hunks].sort((a, b) => (a.state === "staged" ? -1 : 1) - (b.state === "staged" ? -1 : 1));
  for (const h of sorted) {
    const state: ChangeState = h.state === "staged" ? "staged" : "unstaged";
    const removes = h.lines.some((l) => l.kind === "del") || h.oldLines > 0;
    if (h.newLines === 0) {
      const line = Math.min(docLines, Math.max(1, h.newStart - firstLine + 1));
      if (!byLine.has(line) || state === "unstaged") byLine.set(line, { line, kind: "del", state, hunkId: h.id });
      continue;
    }
    for (let k = 0; k < h.newLines; k++) {
      const line = h.newStart - firstLine + 1 + k;
      if (line < 1 || line > docLines) continue;
      byLine.set(line, { line, kind: removes ? "mod" : "add", state, hunkId: h.id });
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

interface ChangeSet {
  marks: RangeSet<GutterMarker>;
  onClick: ((hunkId: string) => void) | null;
}

/** Replace the change bars with these, and say what a click on one does. */
export const setChanges = StateEffect.define<{ marks: ChangeMark[]; onClick: (hunkId: string) => void }>();

const changeField = StateField.define<ChangeSet>({
  create: () => ({ marks: RangeSet.empty, onClick: null }),
  update(value, tr) {
    let marks = value.marks.map(tr.changes);
    let onClick = value.onClick;
    for (const e of tr.effects) {
      if (e.is(setChanges)) {
        onClick = e.value.onClick;
        marks = RangeSet.of(
          e.value.marks
            .filter((m) => m.line >= 1 && m.line <= tr.state.doc.lines)
            .map((m) => new ChangeMarker(m.kind, m.state, m.hunkId).range(tr.state.doc.line(m.line).from)),
          true,
        );
      }
    }
    // What you type shows at once as an unstaged change, until the next refresh.
    if (tr.docChanged && !tr.annotation(External)) {
      const add: Range<GutterMarker>[] = [];
      tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
        const a = tr.state.doc.lineAt(fromB).number;
        const b = tr.state.doc.lineAt(toB).number;
        for (let n = a; n <= b; n++) {
          const pos = tr.state.doc.line(n).from;
          let has = false;
          marks.between(pos, pos, (_f, _t, m) => {
            if ((m as ChangeMarker).state === "unstaged") has = true;
          });
          if (!has && !add.some((r) => r.from === pos)) add.push(new ChangeMarker("mod", "unstaged", null).range(pos));
        }
      });
      if (add.length) marks = marks.update({ add, sort: true, filter: (from) => !add.some((r) => r.from === from) });
    }
    return { marks, onClick };
  },
});

/** The hunk of the change bar on a line, if any. */
export function changeAt(state: EditorState, pos: number): string | null {
  let id: string | null = null;
  state.field(changeField).marks.between(pos, pos, (_f, _t, m) => {
    id = (m as ChangeMarker).hunkId ?? id;
  });
  return id;
}

const changeGutter = gutter({
  class: "cm-change-gutter",
  markers: (v) => v.state.field(changeField).marks,
  initialSpacer: () => spacer,
  domEventHandlers: {
    mousedown(view, line) {
      const id = changeAt(view.state, line.from);
      const set = view.state.field(changeField);
      if (id && set.onClick) {
        set.onClick(id);
        return true;
      }
      return false;
    },
  },
});

// -- changed text: a discreet green highlight where text was added or modified ----

/** A stretch of text of one line (1-based document line, offsets inside the line). */
export interface ChangeSpan {
  line: number;
  from: number;
  to: number;
}

/**
 * The text that is new in your hunks: for a line that replaces another, what lies between
 * their common start and common end; for an added line, its content without the indent.
 */
export function changeSpans(
  hunks: { lines: { kind: string; text: string; new: number | null }[] }[],
  firstLine: number,
  docLines: number,
): ChangeSpan[] {
  const out: ChangeSpan[] = [];
  for (const h of hunks) {
    let dels: string[] = [];
    let prev = "context";
    for (const l of h.lines) {
      if (l.kind === "del") {
        if (prev !== "del") dels = [];
        dels.push(l.text);
      } else if (l.kind === "add" && l.new !== null) {
        const line = l.new - firstLine + 1;
        const old = prev === "add" || prev === "del" ? dels.shift() : undefined;
        if (line >= 1 && line <= docLines) {
          let from = l.text.length - l.text.trimStart().length;
          let to = l.text.trimEnd().length;
          if (old !== undefined && old !== l.text) {
            const n = Math.min(old.length, l.text.length);
            let a = 0;
            while (a < n && old[a] === l.text[a]) a++;
            let b = 0;
            while (b < n - a && old[old.length - 1 - b] === l.text[l.text.length - 1 - b]) b++;
            from = a;
            to = l.text.length - b;
          }
          if (to > from) out.push({ line, from, to });
        }
      }
      prev = l.kind;
    }
  }
  return out;
}

export const setChangeSpans = StateEffect.define<ChangeSpan[]>();

const spanMark = Decoration.mark({ class: "cm-changed" });

const spanField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setChangeSpans)) {
        const doc = tr.state.doc;
        value = Decoration.set(
          e.value
            .filter((sp) => sp.line >= 1 && sp.line <= doc.lines)
            .map((sp) => {
              const ln = doc.line(sp.line);
              return spanMark.range(ln.from + Math.min(sp.from, ln.length), ln.from + Math.min(sp.to, ln.length));
            })
            .filter((r) => r.to > r.from),
          true,
        );
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Ctrl F: open the find bar, or close it when it is already open. */
export function toggleFind(view: EditorView): boolean {
  if (searchPanelOpen(view.state)) closeSearchPanel(view);
  else {
    view.focus();
    openSearchPanel(view);
  }
  return true;
}

// -- the peek: one change of yours, inline under its lines ---------------------

export interface PeekSpec {
  /** Document line the peek goes under. */
  line: number;
  mount: (el: HTMLElement) => () => void;
  key: string;
}

class PeekWidget extends WidgetType {
  private cleanup: (() => void) | null = null;
  constructor(readonly spec: PeekSpec) {
    super();
  }
  eq(o: PeekWidget): boolean {
    return o.spec.key === this.spec.key;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-peek";
    this.cleanup = this.spec.mount(el);
    return el;
  }
  destroy(): void {
    this.cleanup?.();
    this.cleanup = null;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** Show the peek under a line, or none (null). */
export const setPeek = StateEffect.define<PeekSpec | null>();

const peekField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPeek)) {
        const spec = e.value;
        if (!spec) value = Decoration.none;
        else {
          const n = Math.min(tr.state.doc.lines, Math.max(1, spec.line));
          value = Decoration.set([Decoration.widget({ widget: new PeekWidget(spec), block: true, side: 1 }).range(tr.state.doc.line(n).to)]);
        }
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// -- theme ---------------------------------------------------------------------

export const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--fg)", fontSize: "13px", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--code)", lineHeight: "22px", overflow: "auto", overflowAnchor: "none", scrollbarGutter: "stable" },
  ".cm-content": { caretColor: "var(--space)", padding: "0 0 96px" },
  ".cm-changed": { backgroundColor: "color-mix(in srgb, var(--add) 13%, transparent)", borderRadius: "2px" },
  ".cm-line": { padding: "0 16px 0 12px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--space)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--space) 28%, transparent)",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--space) 9%, transparent)" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--gutter)", border: "none", userSelect: "none", zIndex: "2" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "44px", padding: "0 0 0 0", textAlign: "right" },
  ".cm-change-gutter": { width: "14px", paddingLeft: "8px" },
  ".cm-change-gutter .cm-gutterElement": { width: "6px", cursor: "pointer", position: "relative" },
  ".cm-chg": { position: "absolute", left: "1px", top: "1px", bottom: "1px", width: "4px", borderRadius: "2px" },
  ".cm-chg:hover": { width: "6px", left: "0" },
  ".cm-chg-unstaged.cm-chg-add, .cm-chg-unstaged.cm-chg-mod": { background: "var(--warn)" },
  ".cm-chg-staged.cm-chg-add, .cm-chg-staged.cm-chg-mod": { background: "var(--add)" },
  ".cm-chg-staged.cm-chg-mod": { backgroundImage: "repeating-linear-gradient(180deg, transparent 0 3px, rgba(0,0,0,0.25) 3px 4px)" },
  ".cm-chg-unstaged.cm-chg-mod": { backgroundImage: "repeating-linear-gradient(180deg, transparent 0 3px, rgba(0,0,0,0.25) 3px 4px)" },
  ".cm-chg-del": {
    top: "auto",
    bottom: "-4px",
    width: "0",
    height: "0",
    borderRadius: "0",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "6px solid var(--del)",
    zIndex: "2",
  },
  ".cm-chg-del.cm-chg-staged": { borderLeftColor: "color-mix(in srgb, var(--del) 60%, var(--add))" },
  ".cm-peek": { fontFamily: "var(--ui)", padding: "4px 12px 8px 0" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--space) 22%, transparent)" },
  ".cm-hunk": { fontFamily: "var(--ui)" },
  // Find bar (Ctrl F)
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)", zIndex: "3" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-search": { fontFamily: "var(--ui)", fontSize: "12px", padding: "6px 12px", display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" },
  ".cm-search input, .cm-search button": { fontFamily: "var(--ui)", fontSize: "12px" },
  ".cm-search .cm-textfield": {
    background: "var(--raised)",
    color: "var(--fg)",
    border: "1px solid var(--line)",
    borderRadius: "6px",
    padding: "3px 8px",
    outline: "none",
  },
  ".cm-search .cm-textfield:focus": { borderColor: "var(--space)" },
  ".cm-search .cm-button": {
    background: "var(--hover)",
    backgroundImage: "none",
    color: "var(--fg)",
    border: "none",
    borderRadius: "6px",
    padding: "3px 10px",
  },
  ".cm-search label": { color: "var(--muted)", display: "inline-flex", gap: "4px", alignItems: "center" },
  ".cm-search [name=close]": { color: "var(--faint)", fontSize: "16px", padding: "0 6px" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 22%, transparent)", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--warn) 50%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--space) 14%, transparent)" },
});

export const editorHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--info)" },
  { tag: [t.self, t.atom, t.bool, t.null], color: "var(--warn)" },
  { tag: [t.string, t.special(t.string), t.character, t.inserted], color: "var(--add)" },
  { tag: [t.regexp, t.escape, t.special(t.regexp)], color: "var(--syn-str2, var(--add))", fontStyle: "italic" },
  { tag: [t.number, t.integer, t.float, t.unit], color: "var(--warn)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--syn-alt)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], color: "var(--syn-fn)" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "var(--fg)", fontWeight: "500" },
  // Keys of YAML, TOML, JSON, CSS properties, object fields.
  { tag: [t.propertyName, t.labelName], color: "var(--syn-key)" },
  { tag: [t.attributeName], color: "var(--syn-attr)" },
  { tag: [t.attributeValue], color: "var(--add)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--syn-tag)" },
  { tag: [t.variableName, t.special(t.variableName)], color: "var(--fg)" },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: "var(--warn)" },
  { tag: [t.meta, t.annotation, t.processingInstruction, t.documentMeta], color: "var(--syn-meta)" },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.compareOperator], color: "var(--muted)" },
  { tag: [t.punctuation, t.separator, t.bracket], color: "var(--muted)" },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: "var(--fg)", fontWeight: "700" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--info)", textDecoration: "underline" },
  { tag: [t.monospace], color: "var(--syn-key)" },
  { tag: [t.quote], color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.deleted], color: "var(--del)" },
  { tag: [t.changed], color: "var(--warn)" },
  { tag: [t.invalid], color: "var(--del)" },
]);

/** Holds the language of the document; filled once its support is loaded (`setLanguage`). */
export const languageSlot = new Compartment();

/** Load the language of the file and switch the editor to it. */
export async function setLanguage(view: EditorView, lang: Lang, still: () => boolean): Promise<void> {
  const ext = await loadLanguage(lang);
  if (still()) view.dispatch({ effects: languageSlot.reconfigure(ext) });
}

// -- state and helpers ---------------------------------------------------------

export function createState(f: FileContent, onUserChange: (content: string) => void): EditorState {
  return EditorState.create({
    doc: f.content,
    extensions: [
      firstLineFacet.of(f.firstLine),
      lineNumbers({ formatNumber: (n, s) => String(n + s.facet(firstLineFacet) - 1) }),
      changeGutter,
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      search({ top: true }),
      highlightSelectionMatches(),
      Prec.high(keymap.of([{ key: "Mod-f", scope: "editor search-panel", run: toggleFind, preventDefault: true }])),
      keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
      languageSlot.of([]),
      syntaxHighlighting(editorHighlight),
      editorTheme,
      hunkField,
      changeField,
      spanField,
      peekField,
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
