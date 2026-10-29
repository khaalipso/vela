import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "./backend";
import type { Hunk } from "./types";

let b: MockBackend;

beforeEach(() => {
  vi.useFakeTimers();
  b = new MockBackend();
});
afterEach(() => vi.useRealTimers());

const agentHunks = async (id: string) => (await b.hunks(id)).filter((h) => h.origin.type === "agent");
const pending = async (id: string) => (await agentHunks(id)).filter((h) => h.state === "pending");
const byId = async (space: string, id: string): Promise<Hunk> => {
  const h = (await b.hunks(space)).find((x) => x.id === id);
  if (!h) throw new Error(`no hunk ${id}`);
  return h;
};
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("seed", () => {
  it("has the three example spaces with their agents, stack and files", async () => {
    const spaces = await b.listSpaces();
    expect(spaces.map((s) => s.id)).toEqual(["stripe", "pg", "mm"]);
    expect(spaces[0].repos.map((r) => r.name)).toEqual(["api", "web", "infra"]);
    expect((await b.agents("stripe")).map((a) => a.role)).toEqual(["developer", "reviewer", "tester"]);
    expect((await b.stack("stripe")).length).toBe(5);
    expect((await b.listFiles("stripe")).length).toBe(3);
    expect((await pending("stripe")).map((h) => h.id)).toEqual(["s1", "s2", "s3"]);
    expect(await b.question("pg")).toMatchObject({ role: "developer", tool: "crush", yes: "Keep it" });
    expect(await b.question("stripe")).toBeNull();
  });

  it("hunks follow the model contract", async () => {
    const h = await byId("stripe", "s1");
    expect(h).toMatchObject({ repo: "api", path: "src/billing/webhook.ts", oldStart: 14, oldLines: 1, newStart: 14, newLines: 4 });
    expect(h.origin).toEqual({ type: "agent", agent: "stripe-dev" });
    expect(h.lines.map((l) => l.kind)).toEqual(["del", "add", "add", "add", "add"]);
    expect(h.lines[0]).toMatchObject({ old: 14, new: null });
    expect(h.lines[1]).toMatchObject({ old: null, new: 14 });
  });
});

describe("accept, reject, undo, edit", () => {
  it("accepting stages the hunk, applies it to the file and shifts the others", async () => {
    const h = await b.stageHunk("stripe", "s1");
    expect(h.state).toBe("staged");
    expect((await pending("stripe")).map((x) => x.id)).toEqual(["s2", "s3"]);
    const f = await b.readFile("stripe", "api", "src/billing/webhook.ts");
    const lines = f.content.split("\n");
    expect(lines[2]).toBe("  const body = await req.text()");
    expect(lines).toHaveLength(13 + 3);
    expect(lines).not.toContain("  const event = JSON.parse(await req.text())");
    // s3 pointed at line index 3, now 3 lines further
    expect((await byId("stripe", "s3")).newStart).toBe(12 + 6);
    const st = await b.status("stripe");
    expect(st.find((c) => c.path === "src/billing/webhook.ts")).toMatchObject({ staged: "modified", unstaged: null });
  });

  it("accepting emits a change", async () => {
    const seen: string[] = [];
    b.onChange((e) => seen.push(e.spaceId));
    await b.stageHunk("stripe", "s2");
    expect(seen).toEqual(["stripe"]);
  });

  it("rejecting leaves the file alone and removes the hunk from pending", async () => {
    const before = await b.readFile("stripe", "web", "lib/stripe.ts");
    const h = await b.rejectHunk("stripe", "s2");
    expect(h.state).toBe("rejected");
    expect((await pending("stripe")).map((x) => x.id)).toEqual(["s1", "s3"]);
    expect((await b.readFile("stripe", "web", "lib/stripe.ts")).content).toBe(before.content);
    const st = await b.status("stripe");
    expect(st.find((c) => c.path === "lib/stripe.ts")).toBeUndefined();
  });

  it("undo of an accepted hunk restores the file and the other positions", async () => {
    const original = await b.readFile("stripe", "api", "src/billing/webhook.ts");
    const s3 = await byId("stripe", "s3");
    await b.stageHunk("stripe", "s1");
    const back = await b.unstageHunk("stripe", "s1");
    expect(back.state).toBe("pending");
    expect((await b.readFile("stripe", "api", "src/billing/webhook.ts")).content).toBe(original.content);
    expect((await byId("stripe", "s3")).newStart).toBe(s3.newStart);
  });

  it("undo of a rejected hunk makes it pending again", async () => {
    await b.rejectHunk("stripe", "s2");
    expect((await b.unstageHunk("stripe", "s2")).state).toBe("pending");
    expect((await pending("stripe")).map((x) => x.id)).toContain("s2");
  });

  it("edit accepts the hunk", async () => {
    const h = await b.editHunk("stripe", "s2");
    expect(h.state).toBe("staged");
    const f = await b.readFile("stripe", "web", "lib/stripe.ts");
    expect(f.content).toContain("2025-09-30.clover");
  });

  it("accepting twice does not apply twice", async () => {
    await b.stageHunk("stripe", "s2");
    await b.stageHunk("stripe", "s2");
    const f = await b.readFile("stripe", "web", "lib/stripe.ts");
    expect(f.content.split("\n")).toHaveLength(4);
  });
});

describe("your own changes", () => {
  it("writing a file creates a hunk with origin you and an unstaged status", async () => {
    const f = await b.readFile("mm", "research-engine", "tests/ac.rs");
    const lines = f.content.split("\n");
    lines[3] = '    assert!(db.verify("ac6sg").is_ok(), "ac6sg");';
    await b.writeFile("mm", "research-engine", "tests/ac.rs", lines.join("\n"));
    const mine = (await b.hunks("mm")).filter((h) => h.origin.type === "you");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ path: "tests/ac.rs", newStart: 4, newLines: 1, state: "pending" });
    expect(mine[0].lines[0].text).toContain('"ac6sg");');
    const st = await b.status("mm");
    expect(st.find((c) => c.path === "tests/ac.rs")).toMatchObject({ staged: "modified", unstaged: "modified" });
  });

  it("keeps your marks on the right lines when a proposal is applied above them", async () => {
    const f = await b.readFile("stripe", "api", "src/billing/webhook.ts");
    const lines = f.content.split("\n");
    lines[12] = "}  // done";
    await b.writeFile("stripe", "api", "src/billing/webhook.ts", lines.join("\n"));
    await b.stageHunk("stripe", "s1");
    const mine = (await b.hunks("stripe")).filter((h) => h.origin.type === "you");
    expect(mine[0].newStart).toBe(12 + 12 + 3);
  });
});

describe("ask to fix", () => {
  it("resolves the note, updates the proposal and the tests", async () => {
    expect((await b.notes("stripe"))[0]).toMatchObject({ hunkId: "s1", resolved: false, busy: false });
    const seen: { toast?: string }[] = [];
    b.onChange((e) => seen.push(e));
    await b.askFix("stripe", "s1");
    expect((await b.notes("stripe"))[0].busy).toBe(true);
    expect((await b.agents("stripe")).find((a) => a.role === "developer")).toMatchObject({ status: "working" });
    await advance(1400);
    const note = (await b.notes("stripe"))[0];
    expect(note).toMatchObject({ resolved: true, busy: false });
    const h = await byId("stripe", "s1");
    expect(h.state).toBe("pending");
    expect(h.lines.some((l) => l.text.includes("status: 400"))).toBe(true);
    const agents = await b.agents("stripe");
    expect(agents.find((a) => a.role === "tester")).toMatchObject({ status: "done", summary: "14 of 14 tests pass" });
    expect(agents.find((a) => a.role === "reviewer")?.summary).toBe("No blocking notes");
    expect(seen.at(-1)?.toast).toBe("Claude Code updated the proposal");
    const gate = await runGateFast("stripe");
    expect(gate.every((c) => c.pass)).toBe(true);
  });

  it("on an accepted hunk it adds a follow-up proposal after it", async () => {
    await b.stageHunk("stripe", "s1");
    await b.askFix("stripe", "s1");
    await advance(1400);
    const ids = (await agentHunks("stripe")).map((h) => h.id);
    expect(ids).toEqual(["s1", "s1f", "s2", "s3"]);
    const fix = await byId("stripe", "s1f");
    expect(fix.state).toBe("pending");
    expect(fix.lines.filter((l) => l.kind === "del")).toHaveLength(4);
    await b.stageHunk("stripe", "s1f");
    const f = await b.readFile("stripe", "api", "src/billing/webhook.ts");
    expect(f.content).toContain('return new Response("bad signature", { status: 400 })');
    expect(f.content).not.toContain("const event = stripe.webhooks.constructEvent(\n");
  });

  it("does nothing twice", async () => {
    await b.askFix("stripe", "s1");
    await b.askFix("stripe", "s1");
    await advance(1400);
    expect((await agentHunks("stripe")).map((h) => h.id)).toEqual(["s1", "s2", "s3"]);
    await b.askFix("stripe", "s1");
    expect((await b.notes("stripe"))[0].busy).toBe(false);
  });
});

describe("agent questions", () => {
  it("answering clears the question and later adds a proposal", async () => {
    await b.answerAgent("pg", true);
    expect(await b.question("pg")).toBeNull();
    expect((await b.agents("pg")).find((a) => a.tool === "crush")).toMatchObject({ status: "working" });
    expect(await pending("pg")).toHaveLength(2);
    await advance(1600);
    const p = await pending("pg");
    expect(p.map((h) => h.id)).toEqual(["p1", "p2", "p3"]);
    expect(p[2]).toMatchObject({ path: "migrations/0042_trgm.sql", oldLines: 0, newLines: 1 });
    expect((await b.agents("pg")).find((a) => a.tool === "crush")).toMatchObject({ status: "done", summary: "1 new proposal" });
  });

  it("answering no proposes to drop the extension", async () => {
    await b.answerAgent("pg", false);
    await advance(1600);
    const p3 = await byId("pg", "p3");
    expect(p3).toMatchObject({ oldLines: 2, newLines: 1 });
    expect(p3.lines.at(-1)?.text).toContain("pg_trgm dropped");
  });
});

describe("ask an agent", () => {
  it("starts an agent now and delivers a proposal later", async () => {
    const a = await b.askAgent("mm", "tester", "Add a case for $d with three variables");
    expect(a).toMatchObject({ role: "tester", tool: "opencode", status: "working" });
    expect((await b.agents("mm"))[0].id).toBe(a.id);
    expect(await pending("mm")).toHaveLength(0);
    await advance(2200);
    const p = await pending("mm");
    expect(p).toHaveLength(1);
    expect(p[0].lines[0].text).toContain("Add a case for $d with three variables");
    expect((await b.agents("mm"))[0]).toMatchObject({ status: "done" });
  });
});

describe("spaces", () => {
  it("creates a space with a slug, a color, its repos where they are and a planner", async () => {
    const s = await b.createSpace("Refunds in checkout!", ["api", "web"]);
    expect(s).toMatchObject({ id: "refunds-in-checkout", name: "Refunds in checkout!", branch: "main", window: null });
    expect(s.repos.every((r) => r.worktree === r.source)).toBe(true);
    expect(s.repos.map((r) => r.name)).toEqual(["api", "web"]);
    expect((await b.listSpaces()).map((x) => x.id)).toEqual(["stripe", "pg", "mm", "refunds-in-checkout"]);
    expect((await b.agents(s.id))[0]).toMatchObject({ role: "planner", status: "working" });
    expect((await b.stack(s.id))[0]).toMatchObject({ state: "starting" });
    await advance(1800);
    expect((await b.agents(s.id))[0]).toMatchObject({ status: "done" });
    expect((await b.stack(s.id))[0]).toMatchObject({ name: "node", state: "ok" });
  });

  it("gives a unique id to a space with the same name", async () => {
    const a = await b.createSpace("Same", ["api"]);
    const c = await b.createSpace("Same", ["api"]);
    expect(a.id).not.toBe(c.id);
  });

  it("moves a space to another window and back", async () => {
    await b.setWindow("pg", 2);
    expect((await b.listSpaces()).find((s) => s.id === "pg")?.window).toBe(2);
    await b.setWindow("pg", null);
    expect((await b.listSpaces()).find((s) => s.id === "pg")?.window).toBeNull();
  });
});

async function runGateFast(id: string) {
  const p = b.runGate(id);
  await advance(2000);
  return p;
}

describe("commit gate", () => {
  it("runs five checks one after another", async () => {
    const seen: number[] = [];
    const p = b.runGate("mm", (i) => seen.push(i));
    await advance(259);
    expect(seen).toEqual([]);
    await advance(1);
    expect(seen).toEqual([0]);
    await advance(220 * 4);
    const checks = await p;
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(checks.map((c) => c.name)).toEqual(["Reviewer", "Tests touched by the diff", "Lint and types", "Secrets and .env", "Repo rules"]);
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  it("fails on a blocking note and failing tests", async () => {
    const checks = await runGateFast("stripe");
    expect(checks[0]).toMatchObject({ pass: false, detail: "1 blocking" });
    expect(checks[1]).toMatchObject({ pass: false, detail: "12 of 14" });
  });

  it("a rejected hunk no longer carries a blocking note", async () => {
    await b.rejectHunk("stripe", "s1");
    expect((await runGateFast("stripe"))[0].pass).toBe(true);
  });

  it("commit clears staged files and the accepted and rejected hunks", async () => {
    await b.stageHunk("stripe", "s2");
    await b.rejectHunk("stripe", "s3");
    expect((await b.status("stripe")).filter((c) => c.staged)).toHaveLength(2);
    const r = await b.commit("mm", "fix(verify): reject $d");
    expect(r).toEqual({ repos: ["research-engine"], branch: "feat/ac-axiom" });
    expect((await b.status("mm")).filter((c) => c.staged)).toHaveLength(0);
    expect(b.commits[0]).toMatchObject({ spaceId: "mm", message: "fix(verify): reject $d", override: undefined });
  });

  it("commit keeps pending proposals and clears your marks", async () => {
    await b.writeFile("pg", "api", "migrations/0042_trgm.sql", "-- changed\nx\ny");
    await b.stageHunk("pg", "p1");
    // gate on pg: question open does not block the gate, notes do not exist
    await b.commit("pg", "chore(db): pg17");
    expect((await b.status("pg")).filter((c) => c.staged || c.unstaged)).toHaveLength(0);
    expect((await agentHunks("pg")).map((h) => [h.id, h.state])).toEqual([["p2", "pending"]]);
    expect((await b.hunks("pg")).filter((h) => h.origin.type === "you")).toHaveLength(0);
  });

  it("commit is blocked when the gate fails, unless a reason is given", async () => {
    await b.stageHunk("stripe", "s2");
    await expect(b.commit("stripe", "feat")).rejects.toThrow(/Blocked/);
    await expect(b.commit("stripe", "feat", "  ok ")).rejects.toThrow(/Blocked/);
    expect(b.commits).toHaveLength(0);
    const r = await b.commit("stripe", "feat", "Hotfix, tests are flaky on CI");
    expect(r.repos).toEqual(expect.arrayContaining(["web", "api"]));
    expect(b.commits[0].override).toBe("Hotfix, tests are flaky on CI");
    expect((await b.status("stripe")).filter((c) => c.staged)).toHaveLength(0);
  });

  it("commit needs something staged", async () => {
    await expect(b.commit("pg", "nothing")).rejects.toThrow(/staged/);
  });

  it("drafts a message", async () => {
    expect(await b.draftCommit("mm")).toMatch(/^fix\(verify\)/);
  });
});

describe("links", () => {
  it("seeds the example spaces with their context", async () => {
    const stripe = await b.links("stripe");
    expect(stripe.map((l) => [l.kind, l.provider, l.title, l.source])).toEqual([
      ["issue", "jira", "PAY-412", "branch"],
      ["doc", "url", "Stripe webhooks", "manual"],
      ["environment", "url", "Staging acme.dev", "manual"],
      ["dashboard", "grafana", "Payments latency", "repo"],
    ]);
    expect(stripe[0]).toMatchObject({ key: "PAY-412", url: "https://acme.atlassian.net/browse/PAY-412" });
    const pg = await b.links("pg");
    expect(pg.map((l) => [l.kind, l.provider])).toEqual([
      ["issue", "linear"],
      ["doc", "notion"],
    ]);
    expect(await b.links("mm")).toEqual([]);
  });

  it("adds a link, classifies it, dedupes it and tells listeners", async () => {
    const seen: string[] = [];
    b.onChange((e) => seen.push(e.spaceId));
    const l = await b.addLink("mm", "https://linear.app/acme/issue/ENG-9/x");
    expect(l).toMatchObject({ kind: "issue", provider: "linear", key: "ENG-9", source: "manual" });
    expect((await b.addLink("mm", "https://linear.app/acme/issue/ENG-9/x", "again")).id).toBe(l.id);
    const p = await b.addLink("mm", "https://acme.dev/doc", "Doc", "paste");
    expect(p).toMatchObject({ title: "Doc", source: "paste" });
    expect((await b.links("mm")).map((x) => x.id)).toEqual([l.id, p.id]);
    expect(seen.length).toBeGreaterThan(0);
    await expect(b.addLink("mm", "javascript:alert(1)")).rejects.toThrow(/http/);
    await expect(b.addLink("mm", "ftp://x.dev/y")).rejects.toThrow(/http/);
  });

  it("removes links you added, not the ones found in the branch or the repo", async () => {
    const [issue, , , dash] = await b.links("stripe");
    await expect(b.removeLink("stripe", issue.id)).rejects.toThrow(/added/);
    await expect(b.removeLink("stripe", dash.id)).rejects.toThrow(/added/);
    const l = await b.addLink("stripe", "https://acme.dev/mine");
    await b.removeLink("stripe", l.id);
    expect((await b.links("stripe")).some((x) => x.id === l.id)).toBe(false);
    await expect(b.removeLink("stripe", l.id)).rejects.toThrow(/not found/);
  });

  it("opens only http and https URLs", async () => {
    await b.openUrl(" https://acme.dev/x ");
    expect(b.opened).toEqual(["https://acme.dev/x"]);
    await expect(b.openUrl("file:///etc/passwd")).rejects.toThrow(/http/);
    expect(b.opened).toHaveLength(1);
  });
});

describe("commit composer", () => {
  it("plans one commit per repo and kind from the staged hunks, with the ticket footer", async () => {
    const early = await b.commitPlan("stripe");
    expect(early.conventional).toBe(true);
    expect(early.rules.headerMax).toBe(72);
    expect(early.groups).toHaveLength(1);
    expect(early.groups[0]).toMatchObject({
      repo: "api",
      kind: "fix",
      scope: "billing",
      subject: "update checkout",
      footers: ["Refs: PAY-412"],
      hunks: ["base:api/src/billing/checkout.ts"],
    });
    await b.stageHunk("stripe", "s1");
    await b.stageHunk("stripe", "s2");
    const p = await b.commitPlan("stripe");
    expect(p.groups.map((g) => [g.repo, g.kind, g.scope, g.subject])).toEqual([
      ["api", "fix", "billing", "update webhook and checkout"],
      ["web", "fix", "lib", "update stripe"],
    ]);
    expect(p.groups[0].hunks).toEqual(["s1", "base:api/src/billing/checkout.ts"]);
  });

  it("splits tests from code in a space with a test file staged", async () => {
    const p = await b.commitPlan("mm");
    expect(p.groups.map((g) => [g.kind, g.scope, g.subject])).toEqual([
      ["fix", "verify", "update frame"],
      ["test", "ac", "cover ac"],
    ]);
  });

  it("validates like the core", async () => {
    const rules = (await b.commitPlan("mm")).rules;
    expect(await b.validateMessage("feat(api): ok", rules, true)).toEqual([]);
    expect((await b.validateMessage("nope", rules, true)).map((p) => p.field)).toEqual(["header"]);
    expect(await b.validateMessage("nope", rules, false)).toEqual([]);
  });

  it("commits each group as its own commit and keeps what no group takes", async () => {
    const plan = await b.commitPlan("mm");
    const [code, test] = plan.groups;
    const r = await b.commitGroups("mm", [{ ...code, subject: "reject $d with identical variables" }], true);
    expect(r.repos).toEqual(["research-engine"]);
    expect(r.commits).toHaveLength(1);
    expect(b.commits.at(-1)).toMatchObject({
      spaceId: "mm",
      message: "fix(verify): reject $d with identical variables",
      group: code.id,
    });
    // The test hunk is still staged.
    expect((await b.commitPlan("mm")).groups.map((g) => g.hunks)).toEqual([test.hunks]);
    await b.commitGroups("mm", [test], false);
    expect(b.commits.at(-1)!.message).toBe("cover ac");
    expect((await b.status("mm")).filter((c) => c.staged)).toHaveLength(0);
  });

  it("refuses empty subjects, unknown hunks and an empty list", async () => {
    const [g] = (await b.commitPlan("mm")).groups;
    await expect(b.commitGroups("mm", [], true)).rejects.toThrow(/Nothing/);
    await expect(b.commitGroups("mm", [{ ...g, subject: " " }], true)).rejects.toThrow(/no subject/);
    await expect(b.commitGroups("mm", [{ ...g, hunks: ["nope"] }], true)).rejects.toThrow(/Hunk not found/);
    expect(b.commits).toHaveLength(0);
  });

  it("is blocked when the gate fails, unless a reason is given, and the reason becomes a footer", async () => {
    const plan = await b.commitPlan("stripe");
    await expect(b.commitGroups("stripe", plan.groups, true)).rejects.toThrow(/Blocked/);
    await b.commitGroups("stripe", plan.groups, true, "Hotfix, tests are flaky on CI");
    expect(b.commits[0]).toMatchObject({ override: "Hotfix, tests are flaky on CI" });
    expect(b.commits[0].message).toContain("Vela-Override: Hotfix, tests are flaky on CI");
  });
});
