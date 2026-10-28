// The diff of the Review: the whole file, before and after, in CodeMirror. Unified (one column,
// removed lines shown inline) or side by side. The "after" side is the file you get when you
// accept: it can be edited, each change can be reverted, and conflicts are resolved in place.

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { MergeView, goToNextChunk, goToPreviousChunk, unifiedMergeView } from "@codemirror/merge";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { findConflicts, pick, type Side } from "./conflicts";
import { editorHighlight, editorTheme } from "./editor";
import { loadLanguage, type Lang } from "./languages";

export interface PaneOptions {
  parent: HTMLElement;
  before: string;
  after: string;
  lang: Lang;
  split: boolean;
  editable: boolean;
  /** Your typing, a reverted change or a resolved conflict: the new "after". */
  onChange: (doc: string) => void;
  /** A click on a line number of the "after" side. */
  onLine?: (line: number) => void;
}

export interface Pane {
  doc(): string;
  /** Replace the "after" text (keeps the scroll position). */
  setDoc(text: string): void;
  next(): boolean;
  prev(): boolean;
  focus(): void;
  /** Line of the cursor in the "after" side. */
  line(): number;
  /** Scroll to a line of the "after" side. */
  reveal(line: number): void;
  destroy(): void;
}

// -- conflicts, resolved in place ------------------------------------------------

class ConflictBar extends WidgetType {
  constructor(
    readonly index: number,
    readonly total: number,
  ) {
    super();
  }
  eq(o: ConflictBar) {
    return o.index === this.index && o.total === this.total;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-cf-bar";
    const label = document.createElement("span");
    label.textContent = this.total > 1 ? `Conflict ${this.index + 1} of ${this.total}: you and the agent changed these lines` : "Conflict: you and the agent changed these lines";
    el.append(label);
    const btn = (text: string, side: Side, title: string) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title;
      b.onmousedown = (e) => {
        e.preventDefault();
        const c = findConflicts(view.state.doc.toString())[this.index];
        if (!c) return;
        view.dispatch({ changes: { from: c.from, to: c.to, insert: pick(c, side) }, userEvent: "input.resolve" });
      };
      el.append(b);
    };
    btn("Keep yours", "mine", "Keep your lines, drop the agent's");
    btn("Take the agent's", "theirs", "Take the agent's lines, drop yours");
    btn("Keep both", "both", "Your lines, then the agent's");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function conflictDecos(state: EditorState, editable: boolean): DecorationSet {
  const text = state.doc.toString();
  const all = findConflicts(text);
  if (!all.length) return Decoration.none;
  const out: Range<Decoration>[] = [];
  all.forEach((c, i) => {
    const first = state.doc.lineAt(c.from);
    if (editable) out.push(Decoration.widget({ widget: new ConflictBar(i, all.length), block: true, side: -1 }).range(first.from));
    let part: "mine" | "theirs" = "mine";
    for (let n = first.number; n <= state.doc.lines; n++) {
      const l = state.doc.line(n);
      if (l.from >= c.to) break;
      const marker = n === first.number || /^=======$/.test(l.text) || /^>>>>>>> /.test(l.text) || /^\|\|\|\|\|\|\| /.test(l.text);
      if (/^=======$/.test(l.text)) part = "theirs";
      out.push(Decoration.line({ class: marker ? "cm-cf-marker" : part === "mine" ? "cm-cf-mine" : "cm-cf-theirs" }).range(l.from));
    }
  });
  return Decoration.set(out, true);
}

const conflictField = (editable: boolean) =>
  StateField.define<DecorationSet>({
    create: (s) => conflictDecos(s, editable),
    update: (v, tr) => (tr.docChanged ? conflictDecos(tr.state, editable) : v),
    provide: (f) => EditorView.decorations.from(f),
  });

// -- theme -------------------------------------------------------------------------

const mergeTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-changedLine, &.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
    backgroundColor: "color-mix(in srgb, var(--add) 11%, transparent) !important",
  },
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
    backgroundColor: "color-mix(in srgb, var(--del) 11%, transparent) !important",
  },
  ".cm-changedText, &.cm-merge-b .cm-changedText": {
    background: "color-mix(in srgb, var(--add) 30%, transparent) !important",
  },
  "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": {
    background: "color-mix(in srgb, var(--del) 32%, transparent) !important",
  },
  ".cm-deletedChunk": { padding: "0", position: "relative" },
  ".cm-deletedChunk .cm-deletedLine": { padding: "0 16px 0 12px" },
  ".cm-deletedLine del": { textDecoration: "none" },
  ".cm-changeGutter": { width: "4px", paddingLeft: "6px" },
  ".cm-changedLineGutter, &.cm-merge-b .cm-changedLineGutter": { background: "var(--add) !important" },
  "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": { background: "var(--del) !important" },
  ".cm-collapsedLines": {
    background: "var(--hover) !important",
    color: "var(--muted) !important",
    fontFamily: "var(--ui)",
    fontSize: "12px",
    padding: "4px 12px !important",
    cursor: "pointer",
    borderBlock: "1px solid var(--line)",
  },
  ".cm-collapsedLines:hover": { background: "var(--line) !important", color: "var(--fg) !important" },
  ".cm-collapsedLines:before, .cm-collapsedLines:after": { display: "none" },
  ".cm-chunkButtons": { position: "absolute", insetInlineEnd: "10px", top: "2px", zIndex: "2", display: "flex", gap: "4px" },
  ".cm-chunkButtons button": {
    fontFamily: "var(--ui)",
    fontSize: "11.5px",
    fontWeight: "600",
    border: "none",
    borderRadius: "6px",
    padding: "1px 8px",
    cursor: "pointer",
    background: "var(--panel)",
    color: "var(--muted)",
    boxShadow: "0 0 0 1px var(--line)",
  },
  ".cm-chunkButtons button:hover": { color: "var(--fg)", background: "var(--hover)" },
  ".cm-merge-revert": { width: "28px", background: "transparent" },
  ".cm-merge-revert button": {
    border: "none",
    background: "var(--panel)",
    color: "var(--muted)",
    borderRadius: "6px",
    boxShadow: "0 0 0 1px var(--line)",
    cursor: "pointer",
    width: "22px",
    height: "20px",
    padding: "0",
    fontSize: "12px",
  },
  ".cm-merge-revert button:hover": { color: "var(--fg)", background: "var(--hover)" },
  ".cm-cf-bar": {
    fontFamily: "var(--ui)",
    fontSize: "12.5px",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    padding: "6px 12px",
    margin: "4px 0 0",
    background: "color-mix(in srgb, var(--warn) 16%, var(--panel))",
    color: "var(--fg)",
    borderRadius: "8px 8px 0 0",
  },
  ".cm-cf-bar span": { fontWeight: "600", marginRight: "auto" },
  ".cm-cf-bar button": {
    fontFamily: "var(--ui)",
    fontSize: "12px",
    fontWeight: "600",
    border: "none",
    borderRadius: "6px",
    padding: "3px 10px",
    cursor: "pointer",
    background: "var(--panel)",
    color: "var(--fg)",
    boxShadow: "0 0 0 1px var(--line)",
  },
  ".cm-cf-bar button:hover": { background: "var(--hover)" },
  ".cm-cf-marker": { background: "color-mix(in srgb, var(--warn) 22%, transparent)", color: "var(--muted)" },
  ".cm-cf-mine": { background: "color-mix(in srgb, var(--info) 12%, transparent)" },
  ".cm-cf-theirs": { background: "color-mix(in srgb, var(--add) 12%, transparent)" },
  ".cm-lineNumbers .cm-gutterElement": { cursor: "pointer" },
  ".cm-lineNumbers .cm-gutterElement:hover": { color: "var(--space)" },
});

function revertButton(): HTMLElement {
  const b = document.createElement("button");
  b.textContent = "↶";
  b.title = "Revert this change";
  return b;
}

function chunkControls(type: "reject" | "accept", action: (e: MouseEvent) => void): HTMLElement {
  // Only "revert": a change you keep needs no click, accepting the file takes it.
  if (type === "accept") return document.createElement("span");
  const b = document.createElement("button");
  b.textContent = "↶ Revert";
  b.title = "Put these lines back as they were";
  b.onmousedown = (e) => {
    e.preventDefault();
    action(e);
  };
  return b;
}

const COLLAPSE = { margin: 3, minSize: 6 };

/** Build the pane in `parent`. Call `destroy` before building another one there. */
export function createPane(o: PaneOptions): Pane {
  const lang = new Compartment();
  const langB = new Compartment();
  let alive = true;
  const base = (slot: Compartment): Extension[] => [
    lineNumbers(
      o.onLine
        ? {
            domEventHandlers: {
              mousedown: (view, block) => {
                o.onLine?.(view.state.doc.lineAt(block.from).number);
                return true;
              },
            },
          }
        : {},
    ),
    drawSelection(),
    search({ top: true }),
    highlightSelectionMatches(),
    slot.of([]),
    syntaxHighlighting(editorHighlight),
    editorTheme,
    mergeTheme,
  ];
  const after: Extension[] = [
    ...base(langB),
    history(),
    keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
    EditorState.readOnly.of(!o.editable),
    EditorView.editable.of(o.editable),
    conflictField(o.editable),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) o.onChange(u.state.doc.toString());
    }),
  ];

  let view: EditorView;
  let merge: MergeView | null = null;
  if (o.split) {
    merge = new MergeView({
      parent: o.parent,
      a: { doc: o.before, extensions: [...base(lang), EditorState.readOnly.of(true), EditorView.editable.of(false)] },
      b: { doc: o.after, extensions: after },
      revertControls: o.editable ? "a-to-b" : undefined,
      renderRevertControl: revertButton,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: COLLAPSE,
    });
    view = merge.b;
  } else {
    view = new EditorView({
      parent: o.parent,
      state: EditorState.create({
        doc: o.after,
        extensions: [
          ...after,
          unifiedMergeView({
            original: o.before,
            highlightChanges: true,
            gutter: true,
            syntaxHighlightDeletions: true,
            mergeControls: o.editable ? chunkControls : false,
            collapseUnchanged: COLLAPSE,
          }),
        ],
      }),
    });
  }
  void loadLanguage(o.lang).then((ext) => {
    if (!alive) return;
    view.dispatch({ effects: langB.reconfigure(ext) });
    merge?.a.dispatch({ effects: lang.reconfigure(ext) });
  });

  const run = (cmd: typeof goToNextChunk) => {
    const ok = cmd({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
    if (ok) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
    return ok;
  };

  return {
    doc: () => view.state.doc.toString(),
    setDoc(text) {
      const cur = view.state.doc.toString();
      if (cur !== text) view.dispatch({ changes: { from: 0, to: cur.length, insert: text } });
    },
    next: () => run(goToNextChunk),
    prev: () => run(goToPreviousChunk),
    focus: () => view.focus(),
    line: () => view.state.doc.lineAt(view.state.selection.main.head).number,
    reveal(line) {
      const n = Math.min(view.state.doc.lines, Math.max(1, line));
      const pos = view.state.doc.line(n).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    },
    destroy() {
      alive = false;
      if (merge) merge.destroy();
      else view.destroy();
    },
  };
}
