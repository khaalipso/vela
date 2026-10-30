// Long pastes become a chip in the field: the text is not shown, but it is what the agent
// receives. The field holds a token like `[Pasted text #2 · 14 lines]`; a click on the chip puts
// the text back in its place, and sending replaces every token still there by its text.

/** More than this many lines is collapsed. */
export const PASTE_LINES = 5;

const store = new Map<string, string>();
let counter = 0;
const TOKEN = /\[Pasted text #\d+ · \d+ lines\]/g;

const lineCount = (t: string) => t.replace(/\n$/, "").split("\n").length;

/** The chips of a text: its tokens that still stand for a paste. */
export function pastedIn(text: string): { token: string; lines: number }[] {
  const out: { token: string; lines: number }[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const body = store.get(m[0]);
    if (body !== undefined && !out.some((o) => o.token === m[0])) out.push({ token: m[0], lines: lineCount(body) });
  }
  return out;
}

/** What is sent: every token replaced by the text it stands for. */
export function expandPasted(text: string): string {
  return text.replace(TOKEN, (t) => store.get(t) ?? t);
}

/** Break one chip: the text takes the place of its token. */
export function restorePasted(text: string, token: string): string {
  const body = store.get(token);
  return body === undefined ? text : text.replace(token, () => body);
}

/**
 * A paste event in a field: when the text is long, put a token at the cursor instead and return
 * the new value with the cursor position; null when the paste is left to the field.
 */
export function collapsePaste(e: ClipboardEvent, el: HTMLTextAreaElement): { value: string; caret: number } | null {
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (lineCount(text) <= PASTE_LINES) return null;
  e.preventDefault();
  const token = `[Pasted text #${++counter} · ${lineCount(text)} lines]`;
  store.set(token, text);
  const a = el.selectionStart ?? el.value.length;
  const b = el.selectionEnd ?? a;
  return { value: el.value.slice(0, a) + token + el.value.slice(b), caret: a + token.length };
}

/** Unsent text, by field (an agent id, or "composer"): it survives a change of page or agent. */
const drafts = new Map<string, string>();
export const draftOf = (key: string): string => drafts.get(key) ?? "";
export function setDraft(key: string, text: string) {
  if (text) drafts.set(key, text);
  else drafts.delete(key);
}
