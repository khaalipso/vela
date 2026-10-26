import { describe, expect, it } from "vitest";
import { formatCost, formatTokens, logLine, totalUsage, usageLine } from "./agents";
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
