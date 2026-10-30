// Paths in the answers of agents: the system, not the agent, turns a path that names a file of
// the space into a link. Pure functions, the shell wires them to the peek.

export interface FileId {
  repo: string;
  path: string;
}

const norm = (s: string) => s.trim().replace(/^\.\//, "").replace(/[:#]\d+(?:[:-]\d+)?$/, "");

/**
 * The file a piece of text names: `repo/path`, a path from the root of a repo, or the tail of
 * one. Only an unambiguous match counts; text with spaces is never a path.
 */
export function resolveFile(text: string, files: FileId[]): FileId | null {
  const t = norm(text);
  if (!t || /\s/.test(t) || !/[./]/.test(t) || t.length > 300) return null;
  const exact = files.filter((f) => `${f.repo}/${f.path}` === t || f.path === t);
  if (exact.length) return exact.length === 1 ? exact[0] : (exact.find((f) => `${f.repo}/${f.path}` === t) ?? null);
  // An absolute path or a longer relative one ends with `path`; a tail needs a separator.
  const ends = files.filter((f) => t.endsWith(`/${f.path}`) || (t.includes("/") && f.path.endsWith(`/${t}`)));
  return ends.length === 1 ? ends[0] : null;
}

/** Wrap each `<code>` (outside `<pre>`) that names a file of the space in a link. */
export function linkFiles(html: string, files: FileId[]): string {
  if (!files.length || !html.includes("<code")) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  let changed = false;
  for (const code of [...doc.body.querySelectorAll("code")]) {
    if (code.closest("pre") || code.closest("a")) continue;
    const f = resolveFile(code.textContent ?? "", files);
    if (!f) continue;
    const a = doc.createElement("a");
    a.className = "filelink";
    a.setAttribute("href", "#");
    a.setAttribute("data-repo", f.repo);
    a.setAttribute("data-path", f.path);
    a.setAttribute("title", `Changes of ${f.repo}/${f.path}`);
    code.replaceWith(a);
    a.append(code);
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}
