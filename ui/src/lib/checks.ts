// Pure logic of the Checks panel: the state machine driven by `vela://check` events,
// the summary line and the commit gate view of the results.

import type { CheckEvent, GateCheck } from "./backend";
import type { CheckEntry, CheckStatus, RepoChecks } from "./types";

export const checkKey = (repo: string, id: string) => `${repo}/${id}`;

/** Live output per check, keyed by `repo/id`. */
export type Logs = Record<string, string[]>;

/**
 * Apply one event. `running` without a line starts a run (the log restarts); with a line
 * it appends; any other status ends the run. Unknown checks are ignored (the next listing
 * brings them).
 */
export function applyCheckEvent(
  repos: RepoChecks[],
  logs: Logs,
  e: CheckEvent,
): { repos: RepoChecks[]; logs: Logs } {
  const k = checkKey(e.repo, e.id);
  if (!repos.some((r) => r.repo === e.repo && r.checks.some((c) => c.id === e.id))) return { repos, logs };
  let nextLogs = logs;
  if (e.status === "running" && e.line === undefined) nextLogs = { ...logs, [k]: [] };
  else if (e.line !== undefined) nextLogs = { ...logs, [k]: [...(logs[k] ?? []), e.line] };
  if (e.line !== undefined && e.status === "running") return { repos, logs: nextLogs };
  const nextRepos = repos.map((r) =>
    r.repo !== e.repo
      ? r
      : {
          ...r,
          checks: r.checks.map((c): CheckEntry => {
            if (c.id !== e.id) return c;
            if (e.status === "running") return { ...c, status: "running", cached: false, durationMs: null };
            return {
              ...c,
              status: e.status,
              durationMs: e.durationMs ?? c.durationMs ?? null,
              cached: e.cached ?? false,
              exitCode: e.exitCode ?? null,
              timedOut: e.timedOut ?? false,
            };
          }),
        },
  );
  return { repos: nextRepos, logs: nextLogs };
}

export const flatChecks = (repos: RepoChecks[]): CheckEntry[] => repos.flatMap((r) => r.checks);

/** Checks that count: enabled, and the tool exists. */
const counted = (c: CheckEntry) => c.enabled && !c.missing;

/** "3 of 4 passed · tests off", with running, failed and missing tool counts when there are some. */
export function summaryLine(repos: RepoChecks[]): string {
  const all = flatChecks(repos);
  if (!all.length) return "No checks";
  const on = all.filter(counted);
  const passed = on.filter((c) => c.status === "pass" || c.status === "skipped").length;
  const running = on.filter((c) => c.status === "running").length;
  const failed = on.filter((c) => c.status === "fail").length;
  const missing = all.filter((c) => c.enabled && c.missing).length;
  const parts = [on.length ? `${passed} of ${on.length} passed` : "Nothing enabled"];
  if (running) parts.push(`${running} running`);
  if (failed) parts.push(`${failed} failed`);
  if (missing) parts.push(`${missing} missing tool`);
  const off = all.filter((c) => !c.enabled);
  if (off.some((c) => c.kind === "test")) parts.push("tests off");
  if (off.some((c) => c.kind !== "test")) parts.push(`${off.filter((c) => c.kind !== "test").length} off`);
  return parts.join(" · ");
}

export type Verdict = "pass" | "fail" | "running" | "idle" | "none";

/** One word for the whole panel: any failure, else any run in flight, else all passed. */
export function verdict(repos: RepoChecks[]): Verdict {
  const on = flatChecks(repos).filter(counted);
  if (!on.length) return "none";
  if (on.some((c) => c.status === "fail")) return "fail";
  if (on.some((c) => c.status === "running")) return "running";
  if (on.every((c) => c.status === "pass" || c.status === "skipped")) return "pass";
  return "idle";
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} m ${Math.round(s % 60)} s`;
}

export const STATUS_LABEL: Record<CheckStatus, string> = {
  idle: "not run",
  running: "running",
  pass: "passed",
  fail: "failed",
  skipped: "skipped",
  missing: "missing tool",
  disabled: "off",
};

/** The status a row shows: missing and disabled win over the last run. */
export function shownStatus(c: CheckEntry): CheckStatus {
  if (!c.enabled) return "disabled";
  if (c.missing) return "missing";
  return c.status;
}

/** The commit gate reads the enabled checks: one row each, `pass` true for passed and skipped. */
export function gateFromChecks(repos: RepoChecks[]): GateCheck[] {
  return flatChecks(repos)
    .filter(counted)
    .map((c) => ({
      name: c.name,
      detail:
        c.status === "pass" || c.status === "skipped"
          ? `${STATUS_LABEL[c.status]}${c.durationMs ? ` · ${formatDuration(c.durationMs)}` : ""}`
          : STATUS_LABEL[c.status],
      pass: c.status === "pass" || c.status === "skipped",
    }));
}

/** The gate waits while a check runs or has not run yet. */
export function gateSettled(repos: RepoChecks[]): boolean {
  return flatChecks(repos)
    .filter(counted)
    .every((c) => c.status !== "running" && c.status !== "idle");
}
