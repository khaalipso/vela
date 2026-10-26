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
