// Syntax colors for the lines of a diff, with the editor's language support.
// Each side of a hunk (before, after) is parsed as one block so strings and comments that
// span lines color right; context lines take the colors of the after side.

import { Language, LanguageSupport } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { languageOf, loadLanguage } from "./languages";
import type { DiffLine } from "./types";

/** A piece of a line and its color class (`tk-…`), or null for plain text. */
export interface Span {
  text: string;
  cls: string | null;
}

const classes = tagHighlighter([
  {
    tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword],
    class: "tk-kw",
  },
  {
    tag: [t.self, t.atom, t.bool, t.null, t.number, t.integer, t.float, t.unit],
    class: "tk-atom",
  },
  {
    tag: [t.constant(t.variableName), t.standard(t.variableName)],
    class: "tk-atom",
  },
  {
    tag: [t.string, t.special(t.string), t.character, t.attributeValue, t.regexp],
    class: "tk-str",
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    class: "tk-cmt",
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)],
    class: "tk-type",
  },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName],
    class: "tk-fn",
  },
  { tag: [t.propertyName, t.labelName], class: "tk-prop" },
  { tag: [t.attributeName], class: "tk-attr" },
  { tag: [t.tagName, t.angleBracket], class: "tk-tag" },
  { tag: [t.meta, t.annotation, t.processingInstruction], class: "tk-meta" },
  { tag: [t.heading], class: "tk-head" },
]);

function languageIn(ext: Extension): Language | null {
  if (ext instanceof LanguageSupport) return ext.language;
  if (ext instanceof Language) return ext;
  if (Array.isArray(ext)) {
    for (const e of ext) {
      const l = languageIn(e);
      if (l) return l;
    }
  }
  return null;
}

/** Split `text` (lines joined by \n) into colored spans, one array per line. */
function spansOf(lang: Language, lines: string[]): Span[][] {
  const text = lines.join("\n");
  const marks: { from: number; to: number; cls: string }[] = [];
  highlightTree(lang.parser.parse(text), classes, (from, to, cls) => marks.push({ from, to, cls }));
  const out: Span[][] = [];
  let start = 0;
  let m = 0;
  for (const line of lines) {
    const end = start + line.length;
    const spans: Span[] = [];
    let pos = start;
    while (m < marks.length && marks[m].to <= start) m++;
    for (let i = m; i < marks.length && marks[i].from < end; i++) {
      const from = Math.max(marks[i].from, start);
      const to = Math.min(marks[i].to, end);
      if (to <= pos) continue;
      if (from > pos) spans.push({ text: text.slice(pos, from), cls: null });
      spans.push({
        text: text.slice(Math.max(from, pos), to),
        cls: marks[i].cls,
      });
      pos = to;
    }
    if (pos < end) spans.push({ text: text.slice(pos, end), cls: null });
    out.push(spans);
    start = end + 1;
  }
  return out;
}

const cache = new Map<string, Span[][]>();

/** Colored spans for each line of a hunk; null when the language has no support. */
export async function highlightLines(path: string, key: string, lines: DiffLine[]): Promise<Span[][] | null> {
  const hit = cache.get(key);
  if (hit) return hit;
  const lang = languageIn(await loadLanguage(languageOf(path)));
  if (!lang) return null;
  const before = lines.map((l, i) => ({ l, i })).filter((x) => x.l.kind !== "add");
  const after = lines.map((l, i) => ({ l, i })).filter((x) => x.l.kind !== "del");
  const out: Span[][] = lines.map((l) => [{ text: l.text, cls: null }]);
  try {
    const a = spansOf(
      lang,
      after.map((x) => x.l.text),
    );
    after.forEach((x, j) => (out[x.i] = a[j]));
    const b = spansOf(
      lang,
      before.map((x) => x.l.text),
    );
    before.forEach((x, j) => {
      if (x.l.kind === "del") out[x.i] = b[j];
    });
  } catch {
    return null;
  }
  if (cache.size > 400) cache.clear();
  cache.set(key, out);
  return out;
}
