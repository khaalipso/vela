/** Tabular and structured files shown as a table (CSV, TSV) or a tree (JSON, YAML) instead of text. */

export type DataKind = "csv" | "json" | "yaml";

export function dataKind(key: string): DataKind | null {
  if (/\.(csv|tsv)$/i.test(key)) return "csv";
  if (/\.(json|jsonc|json5|geojson)$/i.test(key)) return "json";
  if (/\.(ya?ml)$/i.test(key)) return "yaml";
  return null;
}

/** The delimiter that splits the first lines into the same number of cells, most often. */
export function sniffDelimiter(text: string, key = ""): string {
  if (/\.tsv$/i.test(key)) return "\t";
  const head = text.split(/\r?\n/).slice(0, 5).join("\n");
  let best = ",";
  let bestN = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const n = head.split(d).length - 1;
    if (n > bestN) [best, bestN] = [d, n];
  }
  return best;
}

/** RFC 4180: quoted cells may hold the delimiter, line breaks and "" for a quote. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') (cell += '"'), i++;
        else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) (row.push(cell), (cell = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Numbers sort as numbers, the rest as text (empty cells last). */
export function compareCells(a: string, b: string): number {
  if (a === "" || b === "") return a === b ? 0 : a === "" ? 1 : -1;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Strips comments and trailing commas (.jsonc, .json5 written loosely) outside of strings. */
export function lenientJson(text: string): string {
  let out = "";
  let str = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (str) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') str = false;
    } else if (c === '"') (str = true), (out += c);
    else if (c === "/" && text[i + 1] === "/") while (i < text.length && text[i] !== "\n") i++;
    else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export type Parsed = { ok: true; value: unknown; docs?: number } | { ok: false; error: string };

export function parseJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    try {
      return { ok: true, value: JSON.parse(lenientJson(text)) };
    } catch {
      return { ok: false, error: (e as Error).message };
    }
  }
}

export async function parseYaml(text: string): Promise<Parsed> {
  const { parseAllDocuments } = await import("yaml");
  const docs = parseAllDocuments(text);
  const bad = docs.flatMap((d) => d.errors)[0];
  if (bad) return { ok: false, error: bad.message };
  const values = docs.map((d) => d.toJS());
  return values.length === 1 ? { ok: true, value: values[0] } : { ok: true, value: values, docs: values.length };
}

export type Kind = "object" | "array" | "string" | "number" | "boolean" | "null";

export function kindOf(v: unknown): Kind {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  return t === "object" ? "object" : t === "string" || t === "number" || t === "boolean" ? t : "string";
}

export function children(v: unknown): [string, unknown][] {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x]);
  if (v && typeof v === "object") return Object.entries(v);
  return [];
}

/** `a.b[2].c` for the path [a, b, 2, c]; keys that are not plain names are quoted. */
export function pathString(path: string[], isIndex: boolean[]): string {
  return path
    .map((p, i) => (isIndex[i] ? `[${p}]` : /^[A-Za-z_$][\w$]*$/.test(p) ? (i ? `.${p}` : p) : `[${JSON.stringify(p)}]`))
    .join("");
}
