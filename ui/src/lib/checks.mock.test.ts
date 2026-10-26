// The mock backend's files and checks: what the Review view runs against in the browser.
import { describe, expect, it, vi } from "vitest";
import { MockBackend, type CheckEvent } from "./backend";

const make = () => {
  const b = new MockBackend({ speed: 0 });
  const events: CheckEvent[] = [];
  b.onCheck((e) => events.push(e));
  return { b, events };
};
const finals = (events: CheckEvent[], id: string) => events.filter((e) => e.id === id && e.line === undefined && e.status !== "running");
const entry = async (b: MockBackend, id: string, space = "stripe") =>
  (await b.checks(space)).flatMap((r) => r.checks).find((c) => c.id === id)!;
const settled = async (b: MockBackend, id: string, space = "stripe") => {
  await vi.waitFor(async () => expect(["pass", "fail"]).toContain((await entry(b, id, space)).status));
};

describe("mock files", () => {
  it("staging a file moves it to staged, unstaging brings it back", async () => {
    const { b } = make();
    const f = (await b.listFiles("stripe"))[0];
    const full = await b.readFile("stripe", f.repo, f.path);
    await b.writeFile("stripe", f.repo, f.path, full.content + "\n// mine");
    let st = (await b.status("stripe")).find((c) => c.path === f.path)!;
    expect(st.unstaged).toBe("modified");
    expect(st.staged).toBeNull();
    await b.stageFile("stripe", f.repo, f.path);
    st = (await b.status("stripe")).find((c) => c.path === f.path)!;
    expect(st.staged).toBe("modified");
    expect(st.unstaged).toBeNull();
    await b.unstageFile("stripe", f.repo, f.path);
    st = (await b.status("stripe")).find((c) => c.path === f.path)!;
    expect(st.unstaged).toBe("modified");
    expect(st.staged).toBeNull();
  });
});

describe("mock checks", () => {
  it("lists pre-commit and a failing lint for stripe, tests optional and off", async () => {
    const { b } = make();
    const rc = await b.checks("stripe");
    expect(rc[0]).toMatchObject({ repo: "api", auto: true });
    const by = Object.fromEntries(rc[0].checks.map((c) => [c.id, c]));
    expect(Object.keys(by)).toEqual(["pre-commit", "lint", "test"]);
    expect(by["pre-commit"]).toMatchObject({ kind: "hook", enabled: true, status: "idle" });
    expect(by.test).toMatchObject({ kind: "test", optional: true, enabled: false, status: "disabled" });
    // The other spaces have no failing lint.
    const pg = (await b.checks("pg"))[0].checks.map((c) => c.id);
    expect(pg).toEqual(["pre-commit", "test"]);
  });

  it("run all: events stream, pre-commit passes, lint fails with its log, tests stay off", async () => {
    const { b, events } = make();
    await b.runChecks("stripe");
    await settled(b, "pre-commit");
    await settled(b, "lint");
    const hook = events.filter((e) => e.id === "pre-commit");
    expect(hook[0]).toMatchObject({ status: "running" });
    expect(hook.some((e) => e.line?.includes("Passed"))).toBe(true);
    expect(finals(events, "pre-commit")[0]).toMatchObject({ status: "pass", cached: false, exitCode: 0 });
    expect(finals(events, "lint")[0]).toMatchObject({ status: "fail", exitCode: 1 });
    expect(events.some((e) => e.id === "test")).toBe(false);
    const log = await b.checkLog("stripe", "api", "lint");
    expect(log).toContain("no-unused-vars");
    expect(log).toContain("2 problems");
  });

  it("an unchanged staged set is served from the cache, another file misses", async () => {
    const { b, events } = make();
    await b.stageHunk("stripe", "s2");
    await b.runChecks("stripe", ["pre-commit"]);
    await settled(b, "pre-commit");
    expect(finals(events, "pre-commit")[0].cached).toBe(false);
    await b.runChecks("stripe", ["pre-commit"]);
    await vi.waitFor(() => expect(finals(events, "pre-commit").length).toBe(2));
    expect(finals(events, "pre-commit")[1].cached).toBe(true);
    // listing says pass for this staged set
    expect(await entry(b, "pre-commit")).toMatchObject({ status: "pass", cached: true });
    // stage another proposal: new tree, idle again until it runs
    await b.stageHunk("stripe", "s1");
    await vi.waitFor(async () => expect((await entry(b, "pre-commit")).status).toMatch(/idle|running|pass/));
    await b.runChecks("stripe", ["pre-commit"], true);
    await vi.waitFor(() => expect(finals(events, "pre-commit").length).toBe(3));
    expect(finals(events, "pre-commit")[2].cached).toBe(false);
  });

  it("checks.auto reruns the enabled checks after the staged set changes", async () => {
    const { b, events } = make();
    await b.checks("stripe");
    await b.stageHunk("stripe", "s2");
    await vi.waitFor(() => expect(finals(events, "pre-commit").length).toBe(1));
    await vi.waitFor(() => expect(finals(events, "lint").length).toBe(1));
    expect(events.some((e) => e.id === "test")).toBe(false);
    // turned off: staging more runs nothing
    await b.setChecksAuto("stripe", "api", false);
    const n = events.length;
    await b.stageHunk("stripe", "s1");
    await new Promise((r) => setTimeout(r, 20));
    expect(events.length).toBe(n);
    expect((await b.checks("stripe"))[0].auto).toBe(false);
  });

  it("toggling the optional test turns it on and lets it run", async () => {
    const { b, events } = make();
    await b.setCheckEnabled("stripe", "api", "test", true);
    expect(await entry(b, "test")).toMatchObject({ enabled: true, status: "idle" });
    await b.runChecks("stripe", ["test"]);
    await settled(b, "test");
    expect(finals(events, "test")[0].status).toBe("pass");
    await b.setCheckEnabled("stripe", "api", "test", false);
    expect((await entry(b, "test")).status).toBe("disabled");
  });

  it("a failing lint blocks the commit until a reason is given", async () => {
    const { b } = make();
    await b.stageHunk("stripe", "s2");
    // Settle the reviewer's blocking note so only the lint is left in the way.
    await b.askFix("stripe", "s1");
    await vi.waitFor(async () => expect((await b.notes("stripe")).every((n) => n.resolved)).toBe(true));
    const plan = await b.commitPlan("stripe");
    await b.runChecks("stripe", ["lint"]);
    await settled(b, "lint");
    await expect(b.commitGroups("stripe", plan.groups, plan.conventional)).rejects.toThrow(/Blocked by the commit gate/);
    const done = await b.commitGroups("stripe", plan.groups, plan.conventional, "lint is being fixed in #12");
    expect(done.commits?.length).toBe(plan.groups.length);
    expect(b.commits[0].override).toBe("lint is being fixed in #12");
  });
});
