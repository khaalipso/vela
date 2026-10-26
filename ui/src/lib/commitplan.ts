// Commit composer logic. Messages and validation mirror crates/vela-core/src/commitplan.rs; the plan
// itself is a simplified version of the core's (no packages, no renames) used by the mock backend.
// The group operations at the bottom are what the composer UI runs on its local copy of the plan.

import type { CommitGroup, CommitPlan, CommitRules, CommitType, Hunk, Problem } from "./types";

export const COMMIT_TYPES: CommitType[] = [
  "feat",
  "fix",
  "refactor",
  "perf",
  "test",
  "docs",
  "style",
  "build",
  "ci",
  "chore",
  "revert",
];

export const defaultRules = (): CommitRules => ({ types: [...COMMIT_TYPES], scopes: [], headerMax: 72 });

// -- messages ---------------------------------------------------------------

/** `feat(billing)!: add refunds module`, or just the subject outside conventional repos. */
export function composeHeader(g: CommitGroup, conventional: boolean): string {
  if (!conventional) return g.subject.trim();
  const scope = g.scope?.trim() ? `(${g.scope.trim()})` : "";
  return `${g.kind}${scope}${g.breaking ? "!" : ""}: ${g.subject.trim()}`;
}

/** Full message: header, body, then footers (and `BREAKING CHANGE:` when conventional). */
export function composeMessage(g: CommitGroup, conventional: boolean): string {
  let msg = composeHeader(g, conventional);
  const body = (g.body ?? "").trim();
  if (body) msg += `\n\n${body}`;
  const footers = (g.footers ?? []).map((f) => f.trim()).filter(Boolean);
  if (conventional && g.breaking) {
    footers.unshift(`BREAKING CHANGE: ${g.breakingReason?.trim() || g.subject.trim()}`);
  }
  if (footers.length) msg += `\n\n${footers.join("\n")}`;
  return msg;
}

// -- validation -------------------------------------------------------------

function parseHeader(head: string): { type: string; scope: string | null; subject: string } | null {
  let left: string;
  let subject: string;
  const i = head.indexOf(": ");
  if (i >= 0) {
    left = head.slice(0, i);
    subject = head.slice(i + 2);
  } else if (head.endsWith(":")) {
    left = head.slice(0, -1);
    subject = "";
  } else return null;
  if (left.endsWith("!")) left = left.slice(0, -1);
  let type = left;
  let scope: string | null = null;
  const p = left.indexOf("(");
  if (p >= 0) {
    if (!left.endsWith(")")) return null;
    type = left.slice(0, p);
    scope = left.slice(p + 1, -1);
  }
  if (!/^[a-z]+$/.test(type)) return null;
  return { type, scope, subject };
}

/** Does a commit subject look like `type(scope)!: subject`? */
export function isConventionalSubject(s: string): boolean {
  const h = parseHeader(s);
  return !!h && h.subject.trim() !== "" && (h.scope === null || h.scope !== "");
}

const problem = (field: string, message: string): Problem => ({ field, message });

function checkSubject(subject: string, out: Problem[]) {
  const s = subject.trim();
  if (!s) out.push(problem("subject", "Subject is empty"));
  else if (s.endsWith(".")) out.push(problem("subject", "Subject must not end with a period"));
}

function checkLengthAndBody(head: string, message: string, rules: CommitRules, out: Problem[]) {
  const n = [...head].length;
  if (rules.headerMax > 0 && n > rules.headerMax) {
    out.push(problem("header", `Header is ${n} characters, the limit is ${rules.headerMax}`));
  }
  const second = message.split("\n")[1];
  if (second !== undefined && second.trim() !== "") out.push(problem("body", "Leave a blank line after the header"));
}

/** Check a conventional message against the repo rules. */
export function validateMessage(message: string, rules: CommitRules): Problem[] {
  const out: Problem[] = [];
  const head = (message.split("\n")[0] ?? "").trimEnd();
  const h = parseHeader(head);
  if (!h) out.push(problem("header", "Header must look like type(scope): subject"));
  else {
    if (rules.types.length && !rules.types.includes(h.type)) {
      out.push(problem("type", `Type ${h.type} is not allowed, use one of: ${rules.types.join(", ")}`));
    }
    if (h.scope !== null) {
      if (!h.scope.trim()) out.push(problem("scope", "Scope is empty, drop the parentheses"));
      else if (rules.scopes.length) {
        for (const s of h.scope.split(",").map((x) => x.trim())) {
          if (!rules.scopes.includes(s)) {
            out.push(problem("scope", `Scope ${s} is not allowed, use one of: ${rules.scopes.join(", ")}`));
          }
        }
      }
    }
    checkSubject(h.subject, out);
  }
  checkLengthAndBody(head, message, rules, out);
  return out;
}

/** Rules for a repo that does not use conventional commits: only the basics. */
export function validatePlain(message: string, rules: CommitRules): Problem[] {
  const out: Problem[] = [];
  const head = (message.split("\n")[0] ?? "").trimEnd();
  checkSubject(head, out);
  checkLengthAndBody(head, message, rules, out);
  return out;
}

export const validateFor = (message: string, rules: CommitRules, conventional: boolean): Problem[] =>
  conventional ? validateMessage(message, rules) : validatePlain(message, rules);

// -- path rules -------------------------------------------------------------

const base = (p: string) => p.split("/").pop() ?? p;

export function isTestPath(p: string): boolean {
  const segs = p.split("/");
  const dirs = segs.slice(0, -1);
  const name = base(p);
  return (
    dirs.some((d) => d === "test" || d === "tests" || d === "__tests__") ||
    name.includes(".test.") ||
    name.includes(".spec.") ||
    /_test\.[^.]+$/.test(name) ||
    /^test_.*\.py$/.test(name)
  );
}
const isDocsPath = (p: string) => p.startsWith("docs/") || p.includes("/docs/") || /\.(md|mdx|rst)$/i.test(p);
const isCiPath = (p: string) =>
  p.startsWith(".github/") || p.startsWith(".circleci/") || base(p).startsWith(".gitlab-ci") || base(p) === "Jenkinsfile";
const BUILD_FILES = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "setup.py",
  "mise.toml",
  ".tool-versions",
]);
const isBuildPath = (p: string) => BUILD_FILES.has(base(p)) || /^requirements.*\.txt$/.test(base(p));

/** File name without extensions and test markers; `index`, `mod`, `main`, `lib` give the parent directory. */
export function pathName(p: string): string {
  const name = base(p);
  let stem = name.startsWith(".") ? name : name.split(".")[0];
  stem = stem.replace(/_test$/, "").replace(/^test_/, "");
  if (["index", "mod", "main", "lib", "__init__"].includes(stem)) {
    const segs = p.split("/");
    if (segs.length >= 2) return segs[segs.length - 2];
  }
  return stem;
}

const GENERIC_DIRS = ["src", "test", "tests", "__tests__", "docs", ".github", "scripts", "tools"];

function dirScope(p: string): string | null {
  const dirs = p.split("/").slice(0, -1);
  const i = dirs.indexOf("src");
  if (i >= 0 && i + 1 < dirs.length) return dirs[i + 1];
  const first = dirs[0];
  if (!first || GENERIC_DIRS.includes(first)) return null;
  return first;
}

function commonOf(items: (string | null)[]): string | null {
  const first = items[0];
  if (!first) return null;
  return items.every((x) => x === first) ? first : null;
}

export function scopeFor(paths: string[], tests: boolean): string | null {
  return commonOf(paths.map((p) => (tests ? pathName(p) : dirScope(p))));
}

// -- breaking changes -------------------------------------------------------

function identOf(s: string): string | null {
  return /^[\p{L}\p{N}_$]+/u.exec(s)?.[0] ?? null;
}

/** A public declaration on one line: its name and signature text. */
export function publicDecl(line: string): { name: string; sig: string } | null {
  const t = line.trimStart();
  const sig = (s: string) => s.trimEnd().replace(/\{$/, "").trimEnd();
  let m = /^pub\s+(?:(?:async|const|unsafe)\s+)*(?:fn|struct|enum|trait|type)\s+(.*)$/.exec(t);
  if (m && !t.startsWith("pub(")) {
    const name = identOf(m[1]);
    return name ? { name, sig: sig(t) } : null;
  }
  m = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+(.*)$/.exec(t);
  if (m) {
    const name = identOf(m[1]);
    return name ? { name, sig: sig(t) } : null;
  }
  m = /^export\s+(?:default\s+)?const\s+(.*)$/.exec(t);
  if (m) {
    const name = identOf(m[1]);
    // A constant's value is not its signature.
    return name ? { name, sig: sig(t.split("=")[0]) } : null;
  }
  return null;
}

function envVar(line: string): string | null {
  let t = line.trim().replace(/^- /, "").trim();
  t = t.replace(/^export /, "").replace(/^"|"$/g, "");
  const m = /^([A-Z][A-Z0-9_]{2,})\s*[=:]/.exec(t);
  return m ? m[1] : null;
}

const isConfigPath = (p: string) => {
  const n = base(p);
  return (
    n.startsWith(".env") ||
    n.endsWith(".env") ||
    n.startsWith("compose.") ||
    n.startsWith("docker-compose") ||
    (/\.(ya?ml|toml|json|ini)$/.test(n) && p.toLowerCase().includes("config"))
  );
};

function sqlBreaking(line: string): string | null {
  const l = line.toLowerCase();
  const after = (phrase: string) =>
    new RegExp(`${phrase}\\s+(?:if exists\\s+)?["\`']?([\\w.]+)`).exec(l)?.[1] ?? null;
  const t = after("drop table");
  if (t) return `migration drops table \`${t}\``;
  const c = after("drop column");
  if (c) return `migration drops column \`${c}\``;
  if (l.includes("rename column")) return "migration renames a column";
  if (l.includes("alter table") && l.includes("rename to")) return "migration renames a table";
  if (l.includes("alter column") && l.includes(" type ")) return "migration changes a column type";
  return null;
}

/** Why these hunks break users, if they do. Heuristics, same rules as the core. */
export function breakingReason(hunks: Hunk[]): string | null {
  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks) byFile.set(`${h.repo}/${h.path}`, [...(byFile.get(`${h.repo}/${h.path}`) ?? []), h]);
  const reasons: string[] = [];
  for (const hs of byFile.values()) {
    const path = hs[0].path;
    const lines = hs.flatMap((h) => h.lines);
    const dels = lines.filter((l) => l.kind === "del").map((l) => l.text);
    const adds = lines.filter((l) => l.kind === "add").map((l) => l.text);
    if (/\.(sql|rb)$/.test(path) && path.includes("migrat")) {
      const r = adds.map(sqlBreaking).find(Boolean);
      if (r) reasons.push(r);
      continue;
    }
    if (isConfigPath(path)) {
      const added = new Set(adds.map(envVar).filter(Boolean));
      const gone = dels.map(envVar).find((v) => v && !added.has(v));
      if (gone) reasons.push(`environment variable \`${gone}\` renamed or removed`);
      continue;
    }
    const newDecls = new Map<string, string>();
    for (const a of adds) {
      const d = publicDecl(a);
      if (d) newDecls.set(d.name, d.sig);
    }
    for (const d of dels.map(publicDecl)) {
      if (!d) continue;
      const now = newDecls.get(d.name);
      if (now === undefined) reasons.push(`\`${d.name}\` removed`);
      else if (now !== d.sig) reasons.push(`\`${d.name}\` changed signature`);
    }
  }
  const uniq = reasons.filter((r, i) => reasons.indexOf(r) === i).slice(0, 3);
  return uniq.length ? uniq.join("; ") : null;
}

// -- plan -------------------------------------------------------------------

type Bucket = "code" | "refactor" | "style" | "test" | "docs" | "build" | "ci";
const BUCKET_ORDER: Bucket[] = ["code", "refactor", "style", "test", "docs", "build", "ci"];

const squash = (xs: string[]) => xs.join("").replace(/\s+/g, "");

function bucketOf(path: string, hunks: Hunk[]): Bucket {
  if (isCiPath(path)) return "ci";
  if (isBuildPath(path)) return "build";
  if (isTestPath(path)) return "test";
  if (isDocsPath(path)) return "docs";
  if (hunks.length) {
    const lines = hunks.flatMap((h) => h.lines);
    const del = squash(lines.filter((l) => l.kind === "del").map((l) => l.text));
    const add = squash(lines.filter((l) => l.kind === "add").map((l) => l.text));
    if (del === add) return "style";
  }
  return "code";
}

/** The type a lone hunk would get, used when it is split into a new commit. */
export function kindOfPath(path: string, hunk?: Hunk): CommitType {
  const b = bucketOf(path, hunk ? [hunk] : []);
  if (b === "code") return hunk && isNewFile(hunk) ? "feat" : "fix";
  return ({ refactor: "refactor", style: "style", test: "test", docs: "docs", build: "build", ci: "ci" } as const)[b];
}

/** A hunk that creates a whole file starts at line 0 of nothing. */
const isNewFile = (h: Hunk) => h.oldLines === 0 && h.oldStart === 0;

const joinNames = (names: string[], fallback: string) =>
  names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : fallback;
const distinct = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) === i);

function describe(b: Bucket, paths: string[], newPaths: string[], scope: string | null): [CommitType, string] {
  const names = distinct(paths.map(pathName));
  switch (b) {
    case "code": {
      if (newPaths.length) {
        const n = distinct(newPaths.map(pathName));
        return ["feat", n.length === 1 ? `add ${n[0]} module` : n.length === 2 ? `add ${n[0]} and ${n[1]}` : `add ${scope ?? "new modules"}`];
      }
      return ["fix", `update ${joinNames(names, scope ?? "code")}`];
    }
    case "refactor":
      return ["refactor", "reorganize files"];
    case "style":
      return ["style", "format code"];
    case "test":
      return ["test", `cover ${joinNames(names, scope ?? "changes")}`];
    case "docs":
      return ["docs", "update docs"];
    case "build":
      return ["build", "update dependencies"];
    case "ci":
      return ["ci", "update ci"];
  }
}

export interface PlanOptions {
  conventional?: boolean;
  rules?: CommitRules;
  /** Repo names in the order of the space. */
  repos: string[];
  /** Issue keys for the `Refs:` footer. */
  keys?: string[];
}

/** Propose commits for the staged hunks: one group per repo and kind of change. */
export function planFromHunks(hunks: Hunk[], opts: PlanOptions): CommitPlan {
  const groups: CommitGroup[] = [];
  const footer = opts.keys?.length ? `Refs: ${opts.keys.join(", ")}` : null;
  let n = 0;
  for (const repo of opts.repos) {
    const mine = hunks.filter((h) => h.repo === repo);
    if (!mine.length) continue;
    const byPath = new Map<string, Hunk[]>();
    for (const h of mine) byPath.set(h.path, [...(byPath.get(h.path) ?? []), h]);
    const buckets = new Map<Bucket, string[]>();
    for (const [path, hs] of byPath) {
      const b = bucketOf(path, hs);
      buckets.set(b, [...(buckets.get(b) ?? []), path]);
    }
    for (const b of BUCKET_ORDER) {
      const paths = buckets.get(b);
      if (!paths) continue;
      const hs = mine.filter((h) => paths.includes(h.path));
      const newPaths = paths.filter((p) => byPath.get(p)!.some(isNewFile));
      const scope = scopeFor(paths, b === "test");
      const [kind, subject] = describe(b, paths, newPaths, scope);
      const reason = b === "code" || b === "refactor" ? breakingReason(hs) : null;
      groups.push({
        id: `g${++n}`,
        repo,
        kind,
        scope,
        breaking: !!reason,
        breakingReason: reason,
        subject,
        body: "",
        footers: footer ? [footer] : [],
        hunks: hs.map((h) => h.id),
      });
    }
  }
  return { conventional: opts.conventional ?? true, rules: opts.rules ?? defaultRules(), groups };
}

// -- group operations (pure: they return new arrays) -------------------------

/** Next type allowed by the rules, in the order of `COMMIT_TYPES`. */
export function cycleType(kind: CommitType, rules: CommitRules): CommitType {
  const allowed = COMMIT_TYPES.filter((t) => !rules.types.length || rules.types.includes(t));
  const list = allowed.length ? allowed : COMMIT_TYPES;
  const i = list.indexOf(kind);
  return list[(i + 1) % list.length];
}

/** Move a hunk to another group of the same repo. Empty source groups disappear. */
export function moveHunk(groups: CommitGroup[], hunkId: string, toGroup: number): CommitGroup[] {
  const to = groups[toGroup];
  const from = groups.findIndex((g) => g.hunks.includes(hunkId));
  if (!to || from < 0 || from === toGroup || groups[from].repo !== to.repo) return groups;
  return groups
    .map((g, i) => {
      if (i === from) return { ...g, hunks: g.hunks.filter((h) => h !== hunkId) };
      if (i === toGroup) return { ...g, hunks: [...g.hunks, hunkId] };
      return g;
    })
    .filter((g) => g.hunks.length > 0);
}

let seq = 0;
/** A group id that no group of the list uses. */
export function freshId(groups: CommitGroup[]): string {
  let id: string;
  do id = `n${++seq}`;
  while (groups.some((g) => g.id === id));
  return id;
}

/** Take a hunk out of its group into a new group right after it. Returns the new list and the new group index. */
export function splitHunk(groups: CommitGroup[], hunkId: string, hunk?: Hunk): { groups: CommitGroup[]; index: number } {
  const from = groups.findIndex((g) => g.hunks.includes(hunkId));
  if (from < 0 || groups[from].hunks.length < 2) return { groups, index: from };
  const src = groups[from];
  const path = hunk?.path ?? "";
  const kind = path ? kindOfPath(path, hunk) : src.kind;
  const fresh: CommitGroup = {
    id: freshId(groups),
    repo: src.repo,
    kind,
    scope: path ? scopeFor([path], kind === "test") : src.scope,
    breaking: false,
    breakingReason: null,
    subject: path ? (kind === "test" ? `cover ${pathName(path)}` : `update ${pathName(path)}`) : "update code",
    body: "",
    footers: [...(src.footers ?? [])],
    hunks: [hunkId],
  };
  const next = groups.map((g, i) => (i === from ? { ...g, hunks: g.hunks.filter((h) => h !== hunkId) } : g));
  next.splice(from + 1, 0, fresh);
  return { groups: next, index: from + 1 };
}

/**
 * Merge every group of a repo into one commit (a commit cannot span repos).
 * The group with the most hunks gives type, scope and subject.
 */
export function mergeAll(groups: CommitGroup[]): CommitGroup[] {
  const out: CommitGroup[] = [];
  for (const g of groups) {
    const at = out.findIndex((o) => o.repo === g.repo);
    if (at < 0) {
      out.push({ ...g, hunks: [...g.hunks], footers: [...(g.footers ?? [])] });
      continue;
    }
    const cur = out[at];
    const primary = g.hunks.length > cur.hunks.length ? g : cur;
    const reasons = [cur.breakingReason, g.breakingReason].filter((r): r is string => !!r);
    out[at] = {
      ...cur,
      kind: primary.kind,
      scope: cur.scope === g.scope ? cur.scope : primary.scope,
      subject: primary.subject,
      breaking: !!cur.breaking || !!g.breaking,
      breakingReason: reasons.length ? distinct(reasons).join("; ") : null,
      body: [cur.body, g.body].map((b) => (b ?? "").trim()).filter(Boolean).join("\n\n"),
      footers: distinct([...(cur.footers ?? []), ...(g.footers ?? [])]),
      hunks: [...cur.hunks, ...g.hunks],
    };
  }
  return out;
}
