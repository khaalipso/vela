// Small pure helpers for the agents view: numbers, one line per log event.

import type { Agent, AgentEvent, AgentUsage } from "./types";

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
  "(a command that does not end, a prompt waiting for input, a server you started), then continue without it.";

// -- search ---------------------------------------------------------------------

/** Every word of `query` is found in the agent: labels, request, summary, role, harness, model, id, session. */
export function matchesAgent(a: Agent, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [a.id, a.role, a.tool, a.model ?? "", a.tier ?? "", a.prompt ?? "", a.summary, a.session ?? "", ...(a.labels ?? [])]
    .join("\n")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

// -- chat ---------------------------------------------------------------------

/** One block of the conversation with an agent. */
export type ChatItem =
  | { kind: "you"; text: string; ts: string }
  | { kind: "agent"; text: string; ts: string }
  /** A run of tool calls between two messages, with the files it changed. */
  | { kind: "tools"; calls: { name: string; summary: string }[]; files: string[]; ts: string }
  | { kind: "plan"; steps: string[]; ts: string }
  | { kind: "question"; text: string; options: string[]; ts: string }
  | { kind: "end"; ok: boolean; text: string; ts: string };

/**
 * The event log of an agent as a conversation: your requests and answers, its messages in
 * full, its tool calls grouped between messages, plans, questions and the end of each run.
 * A `done` whose summary repeats the last message adds no text.
 */
export function chatItems(log: { ts: string; event: AgentEvent }[]): ChatItem[] {
  const out: ChatItem[] = [];
  let lastAgent = "";
  for (const { ts, event: e } of log) {
    const prev = out[out.length - 1];
    switch (e.type) {
      case "prompt":
        out.push({ kind: "you", text: e.text, ts });
        break;
      case "message":
        if (!e.text.trim()) break;
        lastAgent = e.text.trim();
        out.push({ kind: "agent", text: e.text, ts });
        break;
      case "toolCall":
      case "fileChanged": {
        const group =
          prev?.kind === "tools" ? prev : (out[out.push({ kind: "tools", calls: [], files: [], ts }) - 1] as Extract<ChatItem, { kind: "tools" }>);
        if (e.type === "toolCall") group.calls.push({ name: e.name, summary: e.summary });
        else if (!group.files.includes(e.path)) group.files.push(e.path);
        break;
      }
      case "plan":
        // A plan that only ticks steps off replaces the one just before it.
        if (prev?.kind === "plan") prev.steps = e.steps;
        else out.push({ kind: "plan", steps: e.steps, ts });
        break;
      case "question":
        out.push({ kind: "question", text: e.text, options: e.options, ts });
        break;
      case "done": {
        const s = e.summary.trim();
        if (s && s !== lastAgent && !lastAgent.endsWith(s)) out.push({ kind: "agent", text: s, ts });
        out.push({ kind: "end", ok: true, text: "Finished", ts });
        lastAgent = "";
        break;
      }
      case "failed":
        out.push({ kind: "end", ok: false, text: e.error === "cancelled" ? "Cancelled" : e.error, ts });
        lastAgent = "";
        break;
      default:
        break;
    }
  }
  return out;
}
