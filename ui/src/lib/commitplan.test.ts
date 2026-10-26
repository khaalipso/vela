import { describe, expect, it } from "vitest";
import {
  breakingReason,
  composeHeader,
  composeMessage,
  cycleType,
  defaultRules,
  freshId,
  isConventionalSubject,
  mergeAll,
  moveHunk,
  pathName,
  planFromHunks,
  publicDecl,
  scopeFor,
  splitHunk,
  validateFor,
  validateMessage,
} from "./commitplan";
import type { CommitGroup, Hunk } from "./types";

const hunk = (repo: string, path: string, lines: [string, string][], o: Partial<Hunk> = {}): Hunk => ({
  id: `${repo}:${path}:${lines.map((l) => l.join("")).join("|")}`,
  repo,
  path,
  oldStart: 5,
  oldLines: 1,
  newStart: 5,
  newLines: 1,
  section: "",
  lines: lines.map(([k, text]) => ({ kind: k === "+" ? "add" : k === "-" ? "del" : "context", text, old: null, new: null })),
  origin: { type: "you" },
  state: "staged",
  ...o,
});
const created = (repo: string, path: string, text = "x"): Hunk =>
  hunk(repo, path, [["+", text]], { oldStart: 0, oldLines: 0 });

const group = (o: Partial<CommitGroup> = {}): CommitGroup => ({
  id: "g1",
  repo: "api",
  kind: "feat",
  scope: "billing",
  breaking: false,
  breakingReason: null,
  subject: "add refunds module",
  body: "",
  footers: [],
  hunks: ["h1"],
  ...o,
});

describe("messages", () => {
  it("composes the header", () => {
    expect(composeHeader(group(), true)).toBe("feat(billing): add refunds module");
    expect(composeHeader(group({ breaking: true }), true)).toBe("feat(billing)!: add refunds module");
    expect(composeHeader(group({ scope: null }), true)).toBe("feat: add refunds module");
    expect(composeHeader(group({ scope: "  " }), true)).toBe("feat: add refunds module");
    expect(composeHeader(group(), false)).toBe("add refunds module");
  });

  it("composes body, BREAKING CHANGE and footers like the core", () => {
    const g = group({ scope: "api", breaking: true, breakingReason: "`pay` removed", body: "Longer text.", footers: ["Refs: PAY-1"] });
    expect(composeMessage(g, true)).toBe(
      "feat(api)!: add refunds module\n\nLonger text.\n\nBREAKING CHANGE: `pay` removed\nRefs: PAY-1",
    );
    expect(composeMessage(g, false)).toBe("add refunds module\n\nLonger text.\n\nRefs: PAY-1");
    expect(composeMessage({ ...g, breakingReason: null }, true)).toContain("BREAKING CHANGE: add refunds module");
  });
});

describe("validate", () => {
  const fields = (m: string) => validateMessage(m, defaultRules()).map((p) => p.field);

  it("accepts good headers", () => {
    expect(fields("feat(billing)!: add refunds module")).toEqual([]);
    expect(fields("fix: handle 400\n\nBody here.")).toEqual([]);
  });

  it("finds the same problems as the core", () => {
    expect(fields("add refunds")).toEqual(["header"]);
    expect(fields("feature: add")).toEqual(["type"]);
    expect(fields("feat: ")).toEqual(["subject"]);
    expect(fields("feat: add.")).toEqual(["subject"]);
    expect(fields("feat(): add")).toEqual(["scope"]);
    expect(fields("feat: add\nno blank line")).toEqual(["body"]);
    expect(fields(`feat: ${"x".repeat(80)}`)).toEqual(["header"]);
    expect(fields("")).toEqual(["header"]);
  });

  it("respects type-enum, scope-enum and header-max-length", () => {
    const r = { types: ["feat", "fix"], scopes: ["api", "web"], headerMax: 20 };
    expect(validateMessage("feat(api): short", r)).toEqual([]);
    expect(validateMessage("feat(api,web): ok", r)).toEqual([]);
    expect(validateMessage("chore(db): this header is long", r).map((p) => p.field)).toEqual(["type", "scope", "header"]);
    expect(validateMessage("fix: ok", r)).toEqual([]);
  });

  it("plain repos only get the basics", () => {
    expect(validateFor("Add refunds", defaultRules(), false)).toEqual([]);
    expect(validateFor("", defaultRules(), false)[0].field).toBe("subject");
    expect(validateFor("Add refunds", defaultRules(), true)).not.toEqual([]);
  });

  it("knows a conventional subject", () => {
    for (const s of ["feat: x", "fix(api): y", "refactor!: z"]) expect(isConventionalSubject(s)).toBe(true);
    for (const s of ["Merge branch main", "Feat: x", "feat:x", "feat(): x"]) expect(isConventionalSubject(s)).toBe(false);
  });
});

describe("paths and scope", () => {
  it("names a file for a subject", () => {
    expect(pathName("src/billing/webhook.ts")).toBe("webhook");
    expect(pathName("src/billing/webhook.test.ts")).toBe("webhook");
    expect(pathName("pkg/webhook_test.go")).toBe("webhook");
    expect(pathName("src/billing/index.ts")).toBe("billing");
    expect(pathName(".env.example")).toBe(".env.example");
  });

  it("scope is the first directory under src, else the top directory, else none", () => {
    expect(scopeFor(["src/billing/a.ts", "src/billing/b.ts"], false)).toBe("billing");
    expect(scopeFor(["src/billing/a.ts", "src/auth/b.ts"], false)).toBeNull();
    expect(scopeFor(["lib/stripe.ts"], false)).toBe("lib");
    expect(scopeFor(["src/main.rs"], false)).toBeNull();
    expect(scopeFor(["README.md"], false)).toBeNull();
    expect(scopeFor(["app/src/billing/a.ts"], false)).toBe("billing");
    expect(scopeFor(["tests/webhook.test.ts"], true)).toBe("webhook");
    expect(scopeFor(["tests/a.rs", "tests/b.rs"], true)).toBeNull();
  });
});

describe("breaking changes", () => {
  it("public declarations", () => {
    expect(publicDecl("pub fn charge(a: u32) {")).toEqual({ name: "charge", sig: "pub fn charge(a: u32)" });
    expect(publicDecl("pub(crate) fn x() {")).toBeNull();
    expect(publicDecl("export default class Pay {")?.name).toBe("Pay");
    expect(publicDecl("export const LIMIT = 10")).toEqual({ name: "LIMIT", sig: "export const LIMIT" });
    expect(publicDecl("fn private() {")).toBeNull();
  });

  it("removed or changed signatures", () => {
    expect(breakingReason([hunk("r", "src/lib.rs", [["-", "pub fn charge(a: u32) {"], ["+", "fn charge(a: u32) {"]])])).toBe("`charge` removed");
    expect(
      breakingReason([hunk("r", "src/lib.rs", [["-", "pub fn charge(a: u32) -> u32 {"], ["+", "pub fn charge(a: u32, b: u32) -> u32 {"]])]),
    ).toBe("`charge` changed signature");
    expect(breakingReason([hunk("r", "src/a.ts", [["-", "export function pay(a: number) {"], ["+", "export function pay(a: string) {"]])])).toBe(
      "`pay` changed signature",
    );
  });

  it("not breaking: additions, private items, bodies, constant values", () => {
    expect(breakingReason([hunk("r", "src/lib.rs", [["+", "pub fn refund() {"]])])).toBeNull();
    expect(breakingReason([hunk("r", "src/lib.rs", [["-", "pub(crate) fn x() {"], ["+", "fn x() {"]])])).toBeNull();
    expect(breakingReason([hunk("r", "src/lib.rs", [["-", "let a = 1;"], ["+", "let a = 2;"]])])).toBeNull();
    expect(breakingReason([hunk("r", "src/a.ts", [["-", "export const LIMIT = 10"], ["+", "export const LIMIT = 20"]])])).toBeNull();
  });

  it("migrations and environment variables", () => {
    expect(breakingReason([created("r", "db/migrations/002.sql", "ALTER TABLE users DROP COLUMN email;")])).toBe(
      "migration drops column `email`",
    );
    expect(breakingReason([created("r", "migrations/003.sql", 'drop table if exists "orders";')])).toBe("migration drops table `orders`");
    expect(breakingReason([created("r", "migrations/004.sql", "ALTER TABLE users ADD COLUMN age int;")])).toBeNull();
    expect(breakingReason([created("r", "scripts/x.sql", "drop table t;")])).toBeNull();
    expect(breakingReason([hunk("r", ".env.example", [["-", "STRIPE_KEY=abc"], ["+", "STRIPE_SECRET_KEY=abc"]])])).toBe(
      "environment variable `STRIPE_KEY` renamed or removed",
    );
    expect(breakingReason([hunk("r", ".env.example", [["-", "STRIPE_KEY=abc"], ["+", "STRIPE_KEY=def"]])])).toBeNull();
    expect(breakingReason([hunk("r", "src/a.ts", [["-", "STRIPE_KEY=abc"]])])).toBeNull();
  });
});

describe("planFromHunks", () => {
  const hunks = [
    created("api", "src/billing/refunds.ts", "export const refund = 1"),
    hunk("api", "src/billing/webhook.ts", [["-", "return 1"], ["+", "return 2"]]),
    created("api", "tests/webhook.test.ts", "test('x')"),
    hunk("api", "README.md", [["+", "Refunds."]]),
    hunk("web", "lib/stripe.ts", [["-", 'apiVersion: "a"'], ["+", 'apiVersion: "b"']]),
  ];
  const plan = planFromHunks(hunks, { repos: ["api", "web", "infra"], keys: ["PAY-412"] });

  it("groups by repo and kind of change", () => {
    expect(plan.groups.map((g) => [g.repo, g.kind])).toEqual([
      ["api", "feat"],
      ["api", "test"],
      ["api", "docs"],
      ["web", "fix"],
    ]);
    expect(plan.groups.map((g) => g.id)).toEqual(["g1", "g2", "g3", "g4"]);
    expect(plan.conventional).toBe(true);
    expect(plan.rules).toEqual(defaultRules());
  });

  it("infers scope and subject from paths", () => {
    expect(plan.groups[0]).toMatchObject({ scope: "billing", subject: "add refunds module" });
    expect(plan.groups[1]).toMatchObject({ scope: "webhook", subject: "cover webhook" });
    expect(plan.groups[2]).toMatchObject({ scope: null, subject: "update docs" });
    expect(plan.groups[3]).toMatchObject({ scope: "lib", subject: "update stripe" });
  });

  it("puts every hunk in exactly one group and adds the ticket footer", () => {
    expect(plan.groups.flatMap((g) => g.hunks).sort()).toEqual(hunks.map((h) => h.id).sort());
    expect(plan.groups.every((g) => g.footers!.join() === "Refs: PAY-412")).toBe(true);
  });

  it("detects style, build and ci changes and breaking reasons", () => {
    const p = planFromHunks(
      [
        hunk("api", "src/fmt.ts", [["-", "const a  =  1"], ["+", "const a = 1"]]),
        hunk("api", "Cargo.lock", [["-", "a"], ["+", "b"]]),
        hunk("api", ".github/workflows/ci.yml", [["+", "on: push"]]),
        hunk("api", "src/pay.rs", [["-", "pub fn charge(a: u32) {"], ["+", "pub fn charge(a: u32, b: u32) {"]]),
      ],
      { repos: ["api"] },
    );
    expect(p.groups.map((g) => g.kind)).toEqual(["fix", "style", "build", "ci"]);
    expect(p.groups[0]).toMatchObject({ breaking: true, breakingReason: "`charge` changed signature", subject: "update pay" });
    expect(p.groups[1].subject).toBe("format code");
    expect(p.groups[2].subject).toBe("update dependencies");
    expect(p.groups[3].subject).toBe("update ci");
    expect(p.groups[1].breaking).toBe(false);
  });

  it("nothing staged, no groups", () => {
    expect(planFromHunks([], { repos: ["api"] }).groups).toEqual([]);
  });
});

describe("group operations", () => {
  const gs = (): CommitGroup[] => [
    group({ id: "a", hunks: ["h1", "h2", "h3"] }),
    group({ id: "b", kind: "test", hunks: ["h4"] }),
    group({ id: "c", repo: "web", hunks: ["h5"] }),
  ];

  it("cycles through the allowed types", () => {
    expect(cycleType("feat", defaultRules())).toBe("fix");
    expect(cycleType("revert", defaultRules())).toBe("feat");
    const r = { types: ["feat", "fix", "deps"], scopes: [], headerMax: 72 };
    expect(cycleType("feat", r)).toBe("fix");
    expect(cycleType("fix", r)).toBe("feat");
    expect(cycleType("docs", r)).toBe("feat");
    expect(cycleType("feat", { types: ["deps"], scopes: [], headerMax: 72 })).toBe("fix");
  });

  it("moves a hunk to another commit of the same repo", () => {
    const next = moveHunk(gs(), "h2", 1);
    expect(next.map((g) => g.hunks)).toEqual([["h1", "h3"], ["h4", "h2"], ["h5"]]);
    expect(moveHunk(gs(), "h2", 2)).toEqual(gs()); // other repo
    expect(moveHunk(gs(), "h2", 0)).toEqual(gs()); // same commit
    expect(moveHunk(gs(), "h2", 7)).toEqual(gs());
    expect(moveHunk(gs(), "nope", 1)).toEqual(gs());
  });

  it("an emptied commit disappears", () => {
    const next = moveHunk(gs(), "h4", 0);
    expect(next.map((g) => g.id)).toEqual(["a", "c"]);
    expect(next[0].hunks).toEqual(["h1", "h2", "h3", "h4"]);
  });

  it("a hunk becomes a commit of its own, right after its commit", () => {
    const h = hunk("api", "tests/a.test.ts", [["+", "x"]], { id: "h2" });
    const r = splitHunk(gs(), "h2", h);
    expect(r.index).toBe(1);
    expect(r.groups.map((g) => g.hunks)).toEqual([["h1", "h3"], ["h2"], ["h4"], ["h5"]]);
    expect(r.groups[1]).toMatchObject({ repo: "api", kind: "test", subject: "cover a", scope: "a" });
    expect(new Set(r.groups.map((g) => g.id)).size).toBe(4);
    // a lone hunk cannot be split off
    expect(splitHunk(gs(), "h4", h).groups).toEqual(gs());
  });

  it("fresh ids never collide", () => {
    const g = gs();
    const a = freshId(g);
    expect(g.some((x) => x.id === a)).toBe(false);
    expect(freshId([...g, group({ id: a })])).not.toBe(a);
  });

  it("merge makes one commit per repo, the biggest one gives the message", () => {
    const m = mergeAll([
      group({ id: "a", hunks: ["h1"], kind: "fix", subject: "small", footers: ["Refs: X-1"] }),
      group({ id: "b", hunks: ["h2", "h3"], kind: "feat", subject: "big", breaking: true, breakingReason: "bye", footers: ["Refs: X-1"] }),
      group({ id: "c", repo: "web", hunks: ["h5"] }),
    ]);
    expect(m.map((g) => [g.id, g.repo])).toEqual([["a", "api"], ["c", "web"]]);
    expect(m[0]).toMatchObject({ kind: "feat", subject: "big", breaking: true, breakingReason: "bye" });
    expect(m[0].hunks).toEqual(["h1", "h2", "h3"]);
    expect(m[0].footers).toEqual(["Refs: X-1"]);
    expect(mergeAll(mergeAll(gs()))).toEqual(mergeAll(gs()));
  });
});
