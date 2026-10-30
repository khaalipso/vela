// The template of an agent's answer: the outcome on top, then one card per `##` section.
// Agents write plain Markdown (see crates/vela-agents/prompts/vela.md); this only cuts it up,
// so an answer that does not follow the shape still shows, as a lead with no sections.

export interface AnswerSection {
  title: string;
  body: string;
  /** Long enough to start closed. */
  long: boolean;
}

export interface Answer {
  /** The text before the first section: the outcome. */
  lead: string;
  sections: AnswerSection[];
}

/** A section longer than this many characters starts closed. */
export const LONG_SECTION = 700;

export function splitAnswer(text: string): Answer {
  const lead: string[] = [];
  const raw: { title: string; lines: string[] }[] = [];
  let fence = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) raw.push({ title: h[1], lines: [] });
    else (raw.length ? raw[raw.length - 1].lines : lead).push(line);
  }
  const sections = raw
    .map((s) => {
      const body = s.lines.join("\n").trim();
      return { title: s.title.replace(/[*_`]/g, "").trim(), body, long: body.length > LONG_SECTION };
    })
    .filter((s) => s.body || s.title);
  return { lead: lead.join("\n").trim(), sections };
}
