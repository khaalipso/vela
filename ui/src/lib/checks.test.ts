import { describe, expect, it } from "vitest";
import type { CheckEvent } from "./backend";
import {
  applyCheckEvent,
  formatDuration,
  gateFromChecks,
  gateSettled,
  shownStatus,
  summaryLine,
  verdict,
} from "./checks";
import type { CheckEntry, RepoChecks } from "./types";

const c = (id: string, o: Partial<CheckEntry> = {}): CheckEntry => ({
  repo: "api",
  id,
  name: id,
  kind: "lint",
  command: id,
  optional: false,
  enabled: true,
  missing: false,
  source: "config",
  when: "staged",
  status: "idle",
  ...o,
});
const repo = (checks: CheckEntry[]): RepoChecks[] => [{ repo: "api", auto: true, checks }];
const ev = (id: string, o: Partial<CheckEvent>): CheckEvent => ({ spaceId: "s", repo: "api", id, status: "running", ...o });

describe("event state machine", () => {
  it("running starts a run and clears the old log", () => {
    const start = applyCheckEvent(repo([c("a", { status: "fail", durationMs: 9 })]), { "api/a": ["old"] }, ev("a", {}));
    expect(start.repos[0].checks[0]).toMatchObject({ status: "running", cached: false, durationMs: null });
    expect(start.logs["api/a"]).toEqual([]);
  });

  it("lines append to the log without changing the status", () => {
    let s = applyCheckEvent(repo([c("a")]), {}, ev("a", {}));
    const before = s.repos;
    s = applyCheckEvent(s.repos, s.logs, ev("a", { line: "one" }));
    s = applyCheckEvent(s.repos, s.logs, ev("a", { line: "two" }));
    expect(s.logs["api/a"]).toEqual(["one", "two"]);
    expect(s.repos).toBe(before);
  });

  it("the final event sets status, duration, cached and exit code", () => {
    let s = applyCheckEvent(repo([c("a"), c("b")]), {}, ev("a", {}));
    s = applyCheckEvent(s.repos, s.logs, ev("a", { status: "fail", durationMs: 1200, cached: false, exitCode: 2, timedOut: false }));
    expect(s.repos[0].checks[0]).toMatchObject({ status: "fail", durationMs: 1200, exitCode: 2, cached: false });
    expect(s.repos[0].checks[1].status).toBe("idle");
    s = applyCheckEvent(s.repos, s.logs, ev("a", { status: "pass", durationMs: 5, cached: true, exitCode: 0 }));
    expect(s.repos[0].checks[0]).toMatchObject({ status: "pass", cached: true });
  });

  it("a final event with a line (an error) logs it too", () => {
    const s = applyCheckEvent(repo([c("a")]), {}, ev("a", { status: "fail", line: "cannot spawn" }));
    expect(s.logs["api/a"]).toEqual(["cannot spawn"]);
    expect(s.repos[0].checks[0].status).toBe("fail");
  });

  it("ignores events of unknown checks", () => {
    const r = repo([c("a")]);
    const s = applyCheckEvent(r, {}, ev("zzz", { status: "pass" }));
    expect(s.repos).toBe(r);
  });
});

describe("summary line", () => {
  it("counts passed of the enabled checks and says tests are off", () => {
    const r = repo([
      c("pre-commit", { kind: "hook", status: "pass" }),
      c("lint", { status: "pass" }),
      c("types", { kind: "types", status: "pass" }),
      c("clippy", { status: "idle" }),
      c("test", { kind: "test", optional: true, enabled: false, status: "disabled" }),
    ]);
    expect(summaryLine(r)).toBe("3 of 4 passed · tests off");
  });

  it("adds running, failed and missing tool", () => {
    const r = repo([
      c("a", { status: "running" }),
      c("b", { status: "fail" }),
      c("c", { status: "pass" }),
      c("d", { missing: true }),
    ]);
    expect(summaryLine(r)).toBe("1 of 3 passed · 1 running · 1 failed · 1 missing tool");
  });

  it("handles no checks and nothing enabled", () => {
    expect(summaryLine([])).toBe("No checks");
    expect(summaryLine(repo([c("a", { enabled: false })]))).toBe("Nothing enabled · 1 off");
  });

  it("verdict: fail beats running beats idle", () => {
    expect(verdict(repo([c("a", { status: "pass" }), c("b", { status: "fail" })]))).toBe("fail");
    expect(verdict(repo([c("a", { status: "running" }), c("b", { status: "pass" })]))).toBe("running");
    expect(verdict(repo([c("a", { status: "pass" }), c("b", { status: "skipped" })]))).toBe("pass");
    expect(verdict(repo([c("a", { status: "pass" }), c("b")]))).toBe("idle");
    expect(verdict(repo([c("a", { enabled: false })]))).toBe("none");
  });
});

describe("rows and gate", () => {
  it("disabled and missing win over the last run", () => {
    expect(shownStatus(c("a", { enabled: false, status: "pass" }))).toBe("disabled");
    expect(shownStatus(c("a", { missing: true, status: "pass" }))).toBe("missing");
    expect(shownStatus(c("a", { status: "fail" }))).toBe("fail");
  });

  it("the gate lists the enabled checks, passing only when they passed", () => {
    const r = repo([
      c("hook", { name: "pre-commit", status: "pass", durationMs: 600 }),
      c("lint", { name: "Lint", status: "fail" }),
      c("test", { optional: true, enabled: false }),
      c("gone", { missing: true }),
    ]);
    expect(gateFromChecks(r)).toEqual([
      { name: "pre-commit", detail: "passed · 600 ms", pass: true },
      { name: "Lint", detail: "failed", pass: false },
    ]);
    expect(gateSettled(r)).toBe(true);
    expect(gateSettled(repo([c("a", { status: "running" })]))).toBe(false);
    expect(gateSettled(repo([c("a")]))).toBe(false);
  });

  it("formats durations", () => {
    expect([450, 1500, 12000, 125000, null].map(formatDuration)).toEqual(["450 ms", "1.5 s", "12 s", "2 m 5 s", ""]);
  });
});
