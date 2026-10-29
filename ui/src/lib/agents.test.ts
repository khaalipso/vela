import { describe, expect, it } from "vitest";
import {
  chatItems,
  currentActivity,
  formatCost,
  formatTokens,
  logLine,
  matchesAgent,
  quietFor,
  shortDuration,
  totalUsage,
  usageLine,
  type ChatItem,
} from "./agents";
import type { Agent } from "./types";

describe("agent numbers", () => {
  it("formats tokens and cost", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(24763)).toBe("25k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0.0421)).toBe("$0.04");
    expect(formatCost(1.2)).toBe("$1.20");
  });

  it("makes a usage line, or none before any usage", () => {
    expect(usageLine(undefined)).toBeNull();
    expect(usageLine({ inputTokens: 0, outputTokens: 0, costUsd: 0 })).toBeNull();
    expect(usageLine({ inputTokens: 2000, outputTokens: 340, costUsd: 0.0421 })).toBe("2.0k in · 340 out · $0.04");
    expect(usageLine({ inputTokens: 10, outputTokens: 5, costUsd: 0 })).toBe("10 in · 5 out");
  });

  it("adds up the agents, ignoring the ones without usage", () => {
    const a = (usage?: Agent["usage"]): Agent => ({ id: "x", space: "s", role: "developer", tool: "claude", worktrees: [], status: "done", summary: "", usage });
    expect(totalUsage([a({ inputTokens: 1, outputTokens: 2, costUsd: 0.5 }), a(), a({ inputTokens: 3, outputTokens: 4, costUsd: 0.25 })])).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      costUsd: 0.75,
    });
  });
});

describe("log lines", () => {
  it("shows what matters and skips the rest", () => {
    expect(logLine({ type: "prompt", text: "do it" })).toEqual({ who: "you", text: "do it" });
    expect(logLine({ type: "toolCall", name: "Edit", summary: "a.ts" })).toEqual({ who: "tool", text: "Edit a.ts" });
    expect(logLine({ type: "fileChanged", path: "a.ts" })).toEqual({ who: "tool", text: "changed a.ts" });
    expect(logLine({ type: "question", text: "Keep it?", options: ["Yes", "No"] })?.text).toBe("Asks: Keep it? (Yes / No)");
    expect(logLine({ type: "failed", error: "cancelled" })).toEqual({ who: "end", text: "Cancelled" });
    expect(logLine({ type: "failed", error: "boom" })?.text).toBe("Failed: boom");
    expect(logLine({ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: null, model: "m" })).toBeNull();
    expect(logLine({ type: "sessionStarted", session: "s" })).toBeNull();
  });
});

describe("chatItems", () => {
  const at = (event: import("./types").AgentEvent) => ({ ts: "t", event });
  it("turns the log into a conversation with grouped tools", () => {
    const items = chatItems([
      at({ type: "prompt", text: "Is the doc up to date?" }),
      at({ type: "sessionStarted", session: "s" }),
      at({ type: "toolCall", name: "Read", summary: "docs/SPEC.md" }),
      at({ type: "toolCall", name: "Grep", summary: "TODO" }),
      at({ type: "message", text: "Mostly. Two gaps:\n- keys\n- PRs" }),
      at({ type: "toolCall", name: "Edit", summary: "docs/SPEC.md" }),
      at({ type: "fileChanged", path: "docs/SPEC.md" }),
      at({ type: "plan", steps: ["a", "b"] }),
      at({ type: "plan", steps: ["a", "b", "c"] }),
      at({ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: null, model: "m" }),
      at({ type: "done", summary: "Two gaps:\n- keys\n- PRs" }),
      at({ type: "prompt", text: "Fix them" }),
      at({ type: "failed", error: "cancelled" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["you", "tools", "agent", "tools", "plan", "end", "you", "end"]);
    const tools = items[1] as Extract<ChatItem, { kind: "tools" }>;
    expect(tools.calls.map((c) => c.name)).toEqual(["Read", "Grep"]);
    expect((items[3] as Extract<ChatItem, { kind: "tools" }>).files).toEqual(["docs/SPEC.md"]);
    expect((items[4] as Extract<ChatItem, { kind: "plan" }>).steps).toEqual(["a", "b", "c"]);
    expect(items[7]).toMatchObject({ ok: false, text: "Cancelled" });
  });

  it("keeps a final summary that says more than the last message", () => {
    const items = chatItems([at({ type: "message", text: "Looking." }), at({ type: "done", summary: "The doc is current except for keys." })]);
    expect(items.map((i) => i.kind)).toEqual(["agent", "agent", "end"]);
  });
});

describe("activity and search", () => {
  const base: Agent = { id: "developer-1", space: "s", role: "developer", tool: "claude", worktrees: [], status: "working", summary: "" };

  it("counts the quiet time from the last event, only while it works", () => {
    const now = Date.parse("2026-10-29T10:30:00Z");
    expect(quietFor({ ...base, lastEvent: "2026-10-29T10:00:00Z" }, now)).toBe(30 * 60_000);
    // The newest of the agent's last event and the log wins.
    expect(quietFor({ ...base, lastEvent: "2026-10-29T10:00:00Z" }, now, "2026-10-29T10:29:00Z")).toBe(60_000);
    expect(quietFor({ ...base, status: "done", lastEvent: "2026-10-29T10:00:00Z" }, now)).toBe(0);
    expect(quietFor(base, now)).toBe(0);
    expect(shortDuration(45_000)).toBe("45s");
    expect(shortDuration(12 * 60_000)).toBe("12 min");
    expect(shortDuration(65 * 60_000)).toBe("1 h 05");
  });

  it("says what it does: its activity, else the last tool call of the log", () => {
    expect(currentActivity({ ...base, activity: "Bash: cargo test" })).toBe("Bash: cargo test");
    expect(
      currentActivity(base, [
        { event: { type: "toolCall", name: "Read", summary: "a.ts" } },
        { event: { type: "toolCall", name: "Bash", summary: "pnpm dev" } },
      ]),
    ).toBe("Bash: pnpm dev");
    expect(currentActivity(base, [{ event: { type: "toolCall", name: "Read", summary: "a.ts" } }, { event: { type: "message", text: "ok" } }])).toBe("");
  });

  it("finds an agent by every word of the query", () => {
    const a: Agent = { ...base, prompt: "Handle charge.refunded", labels: ["PAY-412", "refunds"], session: "0f3c-9a51" };
    expect(matchesAgent(a, "")).toBe(true);
    expect(matchesAgent(a, "pay-412")).toBe(true);
    expect(matchesAgent(a, "refunds developer")).toBe(true);
    expect(matchesAgent(a, "0f3c")).toBe(true);
    expect(matchesAgent(a, "refunds tester")).toBe(false);
  });
});
