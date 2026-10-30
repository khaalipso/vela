// A commit's `git show` text as files with hunks the diff block can draw.

import type { DiffLine, Hunk } from "./types";

export interface CommitFile {
  path: string;
  /** Where it came from, for a rename. */
  from?: string;
  status: "modified" | "added" | "deleted" | "renamed" | "binary";
  added: number;
  removed: number;
  hunks: Hunk[];
}

export function parseCommitDiff(repo: string, text: string): CommitFile[] {
  const out: CommitFile[] = [];
  let f: CommitFile | null = null;
  let h: Hunk | null = null;
  let o = 0;
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      f = { path: m?.[2] ?? line.slice(11), status: "modified", added: 0, removed: 0, hunks: [] };
      out.push(f);
      h = null;
    } else if (!f) {
      continue;
    } else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
      if (!m) continue;
      o = Number(m[1]);
      n = Number(m[3]);
      h = {
        id: `${repo}:${f.path}:${f.hunks.length}`,
        repo,
        path: f.path,
        oldStart: o,
        oldLines: Number(m[2] ?? 1),
        newStart: n,
        newLines: Number(m[4] ?? 1),
        section: m[5],
        lines: [],
        origin: { type: "you" },
        state: "pending",
      };
      f.hunks.push(h);
    } else if (h && (line[0] === "+" || line[0] === "-" || line[0] === " ")) {
      const t = line.slice(1);
      let l: DiffLine;
      if (line[0] === "+") (l = { kind: "add", text: t, old: null, new: n++ }), f.added++;
      else if (line[0] === "-") (l = { kind: "del", text: t, old: o++, new: null }), f.removed++;
      else l = { kind: "context", text: t, old: o++, new: n++ };
      h.lines.push(l);
    } else if (line.startsWith("new file mode")) f.status = "added";
    else if (line.startsWith("deleted file mode")) f.status = "deleted";
    else if (line.startsWith("rename from ")) (f.status = "renamed"), (f.from = line.slice(12));
    else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) f.status = "binary";
  }
  return out;
}
