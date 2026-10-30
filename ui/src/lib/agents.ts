// Small pure helpers for the agents view: numbers, one line per log event.

import type { Agent, AgentEvent, AgentRole, AgentUsage } from "./types";

/** 1234 → "1.2k", 1500000 → "1.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Dollars with the precision that matters: "$0.04", "$1.20", "<$0.01". */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** "12k in · 340 out · $0.04", or null when the agent has not reported usage yet. */
export function usageLine(u: AgentUsage | undefined): string | null {
  if (!u || (u.inputTokens === 0 && u.outputTokens === 0 && u.costUsd === 0)) return null;
  const parts = [`${formatTokens(u.inputTokens)} in`, `${formatTokens(u.outputTokens)} out`];
  if (u.costUsd > 0) parts.push(formatCost(u.costUsd));
  return parts.join(" · ");
}

/** The usage of all agents added up. */
export function totalUsage(agents: Agent[]): AgentUsage {
  return agents.reduce(
    (t, a) => ({
      inputTokens: t.inputTokens + (a.usage?.inputTokens ?? 0),
      outputTokens: t.outputTokens + (a.usage?.outputTokens ?? 0),
      costUsd: t.costUsd + (a.usage?.costUsd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}

/** One line for the log view; null for events that are not worth a line. */
export function logLine(e: AgentEvent): { who: "you" | "agent" | "tool" | "end"; text: string } | null {
  switch (e.type) {
    case "prompt":
      return { who: "you", text: e.text };
    case "message":
      return { who: "agent", text: e.text };
    case "plan":
      return { who: "agent", text: `Plan: ${e.steps.join("; ")}` };
    case "toolCall":
      return { who: "tool", text: e.summary ? `${e.name} ${e.summary}` : e.name };
    case "fileChanged":
      return { who: "tool", text: `changed ${e.path}` };
    case "question":
      return { who: "agent", text: `Asks: ${e.text}${e.options.length ? ` (${e.options.join(" / ")})` : ""}` };
    case "applied":
      return { who: "tool", text: `applied ${e.files.join(", ")}${e.conflicts.length ? `; conflicts in ${e.conflicts.join(", ")}` : ""}` };
    case "done":
      return { who: "end", text: "Finished" };
    case "failed":
      return { who: "end", text: e.error === "cancelled" ? "Cancelled" : `Failed: ${e.error}` };
    default:
      return null;
  }
}

/** The statuses in which an agent still has a process. */
export function isRunning(a: Agent): boolean {
  return a.status === "working";
}

// -- activity -------------------------------------------------------------------

/** An agent at work with no event for this long is shown as maybe stuck. */
export const QUIET_WARN_MS = 5 * 60_000;

/** How long a working agent has been silent (ms), from its last event; 0 when it does not work. */
export function quietFor(a: Agent, now: number, lastLogTs?: string | null): number {
  if (!isRunning(a)) return 0;
  const times = [a.lastEvent, lastLogTs, a.started].map((t) => (t ? Date.parse(t) : NaN)).filter((t) => !Number.isNaN(t));
  if (!times.length) return 0;
  return Math.max(0, now - Math.max(...times));
}

/** "45s", "12 min", "1 h 05". */
export function shortDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

/** What a working agent does now: its activity, else its last tool call in the log. */
export function currentActivity(a: Agent, log?: { event: AgentEvent }[] | null): string {
  if (a.activity?.trim()) return a.activity.trim();
  for (let i = (log?.length ?? 0) - 1; i >= 0; i--) {
    const e = log![i].event;
    if (e.type === "toolCall") return e.summary ? `${e.name}: ${e.summary}` : e.name;
    if (e.type === "message" || e.type === "prompt") break;
  }
  return "";
}

/** What you send to an agent that went quiet: it reads it when it resumes. */
export const NUDGE =
  "You were stopped because nothing happened for a while. Say in two lines where you are and what blocked you " +
  "(a command that does not end, a prompt waiting for input, a server you started), then continue without it. Keep writing in the language of the conversation so far.";

// -- search ---------------------------------------------------------------------

/** Every word of `query` is found in the agent: labels, request, summary, role, harness, model, id, session. */
export function matchesAgent(a: Agent, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [a.id, a.title ?? "", a.role, a.tool, a.model ?? "", a.tier ?? "", a.prompt ?? "", a.summary, a.session ?? "", ...(a.labels ?? [])]
    .join("\n")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** A permission request: Allow / Deny (or Approve / Reject) rather than a real question. */
export function isPermission(options: string[]): boolean {
  return options.length >= 2 && /^(allow|approve|yes|always)/i.test(options[0]);
}

/** Did the answer to a permission say yes? Mirrors `is_yes` of the agents crate. */
export function isAllowed(answer: string): boolean {
  const w = answer.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase() ?? "";
  return ["allow", "always", "yes", "y", "approve", "approved", "ok", "okay", "sure", "oui"].includes(w);
}

/** The label of a permission button: "Allow once" is just "Allow", "Reject" is "Deny". */
export function permissionLabel(option: string): string {
  if (/^allow once$/i.test(option)) return "Allow";
  if (/^(reject|reject once|deny once)$/i.test(option)) return "Deny";
  return option;
}

// -- handoff ------------------------------------------------------------------

/** What to do next with the answer of an agent: the role that takes it over and what it is asked. */
export interface NextStep {
  role: AgentRole;
  label: string;
  ask: string;
  /** One sentence for the button: what the next agent will do with the answer. */
  hint: string;
}

const NEXT: Partial<Record<AgentRole, NextStep[]>> = {
  planner: [
    { role: "developer", label: "Implement", hint: "The developer carries out this plan in its own worktree.", ask: "Implement this plan. Follow it step by step; say where you had to depart from it." },
    { role: "tester", label: "Write the tests", hint: "The tester writes the tests the plan calls for, before the code exists.", ask: "Write the tests this plan calls for, before it is implemented." },
  ],
  product: [
    { role: "planner", label: "Plan it", hint: "The planner turns this into steps for this code base, without changing files.", ask: "Turn this into an implementation plan for this code base." },
    { role: "developer", label: "Implement", hint: "The developer builds this in its own worktree.", ask: "Implement this." },
  ],
  developer: [
    { role: "reviewer", label: "Review", hint: "A read only reviewer checks these changes and reports findings.", ask: "Review the changes described below, and the uncommitted changes of the space." },
    { role: "tester", label: "Test it", hint: "The tester writes or completes the tests for these changes.", ask: "Write or complete the tests for the changes described below." },
  ],
  tester: [{ role: "reviewer", label: "Review", hint: "A read only reviewer checks these tests and what they cover.", ask: "Review these tests and the changes they cover." }],
  debugger: [{ role: "developer", label: "Fix it", hint: "The developer fixes the diagnosed bug and adds a test for it.", ask: "Fix the bug as diagnosed below. Add a test that fails without the fix." }],
  reviewer: [{ role: "developer", label: "Fix these", hint: "The developer fixes the findings, most severe first, and nothing else.", ask: "Fix the findings below, most severe first. Change only what they ask for." }],
  security: [{ role: "developer", label: "Fix these", hint: "The developer fixes the findings, most severe first, and nothing else.", ask: "Fix the findings below, most severe first. Change only what they ask for." }],
};

/** The agents that can take over after `role`. */
export function nextSteps(role: AgentRole): NextStep[] {
  return NEXT[role] ?? [];
}

/** The request to give the next agent: what to do, then the answer it starts from. */
export function handoffText(step: NextStep, from: AgentRole, answer: string): string {
  return `${step.ask}\nAnswer in the language of the text below.\n\n---\nAnswer of the ${from}:\n\n${answer.trim()}`;
}

// -- chat ---------------------------------------------------------------------

/** What the agent thought (its reasoning) or said while it worked, between its tool calls. */
export type WorkNote = { kind: "thought" | "said"; before: number; text: string };

/** One block of the conversation with an agent. */
export type ChatItem =
  | { kind: "you"; text: string; ts: string }
  | { kind: "agent"; text: string; ts: string }
  /**
   * The work between two answers: tool calls, the files they changed, and what the agent thought
   * or said along the way (`before`: the index of the call it came before).
   */
  | { kind: "tools"; calls: { name: string; summary: string }[]; notes: WorkNote[]; files: string[]; ts: string }
  | { kind: "plan"; steps: string[]; ts: string }
  | { kind: "question"; text: string; options: string[]; ts: string; answer?: string }
  | { kind: "applied"; files: string[]; conflicts: string[]; toYou: boolean; ts: string }
  | { kind: "end"; ok: boolean; text: string; ts: string };

/**
 * The event log of an agent as a conversation: your requests and answers, its answers in
 * full, its tool calls grouped between answers, plans, questions and the end of each run.
 * A message followed by more tool calls is work in progress, not an answer: it goes into the
 * group of those calls, with the reasoning. A `done` whose summary repeats the last answer adds
 * no text.
 */
export function chatItems(log: { ts: string; event: AgentEvent }[]): ChatItem[] {
  const out: ChatItem[] = [];
  let lastAgent = "";
  /** The latest message, until we know whether tool calls follow it. */
  let pending: { text: string; ts: string } | null = null;
  const flush = () => {
    if (!pending) return;
    lastAgent = pending.text.trim();
    out.push({ kind: "agent", text: pending.text, ts: pending.ts });
    pending = null;
  };
  for (const { ts, event: e } of log) {
    switch (e.type) {
      case "prompt": {
        flush();
        const prev = out[out.length - 1];
        // The answer to a permission goes into its card, which turns green or red.
        if (prev?.kind === "question" && isPermission(prev.options) && prev.answer === undefined) prev.answer = e.text;
        else out.push({ kind: "you", text: e.text, ts });
        break;
      }
      case "message":
        if (!e.text.trim()) break;
        flush();
        pending = { text: e.text, ts };
        break;
      case "reasoning":
      case "toolCall":
      case "fileChanged": {
        if (e.type === "reasoning" && !e.text.trim()) break;
        const prev = out[out.length - 1];
        const group =
          prev?.kind === "tools"
            ? prev
            : (out[out.push({ kind: "tools", calls: [], notes: [], files: [], ts }) - 1] as Extract<ChatItem, { kind: "tools" }>);
        if (pending) {
          group.notes.push({ kind: "said", before: group.calls.length, text: pending.text.trim() });
          pending = null;
        }
        if (e.type === "reasoning") group.notes.push({ kind: "thought", before: group.calls.length, text: e.text.trim() });
        else if (e.type === "toolCall") group.calls.push({ name: e.name, summary: e.summary });
        else if (!group.files.includes(e.path)) group.files.push(e.path);
        break;
      }
      case "plan": {
        const prev = out[out.length - 1];
        // A plan that only ticks steps off replaces the one just before it.
        if (prev?.kind === "plan") prev.steps = e.steps;
        else out.push({ kind: "plan", steps: e.steps, ts });
        break;
      }
      case "question":
        flush();
        out.push({ kind: "question", text: e.text, options: e.options, ts });
        break;
      case "applied":
        flush();
        out.push({ kind: "applied", files: e.files, conflicts: e.conflicts ?? [], toYou: !!e.toYou, ts });
        break;
      case "done": {
        flush();
        const s = e.summary.trim();
        if (s && s !== lastAgent && !lastAgent.endsWith(s)) out.push({ kind: "agent", text: s, ts });
        out.push({ kind: "end", ok: true, text: "Finished", ts });
        lastAgent = "";
        break;
      }
      case "failed":
        flush();
        out.push({ kind: "end", ok: false, text: e.error === "cancelled" ? "Cancelled" : e.error, ts });
        lastAgent = "";
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}
