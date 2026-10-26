// TauriBackend agent methods against a mocked `invoke` and event bus.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listeners = new Map<string, (e: { payload: unknown }) => void>();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return unlisten;
  },
}));

import { AGENT_EVENT, TauriBackend, type AgentNotice } from "./backend";
import type { Agent, Hunk } from "./types";

beforeEach(() => {
  invoke.mockReset();
  unlisten.mockReset();
  listeners.clear();
});

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "developer-1",
  space: "s",
  role: "developer",
  tool: "claude",
  worktrees: [["api", "/h/worktrees/s/.agents/developer-1/api"]],
  status: "working",
  summary: "",
  ...over,
});

describe("TauriBackend agents", () => {
  const b = new TauriBackend();

  it("lists harnesses, agents and role defaults", async () => {
    invoke.mockResolvedValue([]);
    await b.harnesses();
    await b.agents("s");
    await b.roleDefaults("s");
    await b.reasons("s");
    expect(invoke.mock.calls).toEqual([
      ["harnesses", undefined],
      ["agents", { spaceId: "s" }],
      ["agent_defaults", { spaceId: "s" }],
      ["reasons", { spaceId: "s" }],
    ]);
  });

  it("asks an agent with the harness and tier overrides, or nulls", async () => {
    invoke.mockResolvedValue(agent());
    await b.askAgent("s", "developer", "do it");
    await b.askAgent("s", "tester", "test it", { harness: "codex", tier: "high" });
    expect(invoke.mock.calls).toEqual([
      ["ask_agent", { spaceId: "s", role: "developer", prompt: "do it", harness: null, tier: null }],
      ["ask_agent", { spaceId: "s", role: "tester", prompt: "test it", harness: "codex", tier: "high" }],
    ]);
  });

  it("answers yes and no with the first two options the agent offered", async () => {
    const q = { agentId: "developer-1", role: "developer", tool: "claude", text: "Run it?", yes: "Allow", no: "Deny", options: ["Allow", "Deny"] };
    invoke.mockImplementation(async (cmd: string) => (cmd === "question" ? q : agent()));
    await b.answerAgent("s", true);
    await b.answerAgent("s", false);
    const answers = invoke.mock.calls.filter((c) => c[0] === "answer_agent");
    expect(answers).toEqual([
      ["answer_agent", { spaceId: "s", agent: "developer-1", text: "Allow" }],
      ["answer_agent", { spaceId: "s", agent: "developer-1", text: "Deny" }],
    ]);
  });

  it("does nothing when no agent waits", async () => {
    invoke.mockResolvedValue(null);
    await b.answerAgent("s", true);
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["question"]);
  });

  it("answers in words, cancels and reads the log", async () => {
    invoke.mockResolvedValue(null);
    await b.answerAgentText("s", "developer-1", "keep it");
    await b.cancelAgent("s", "developer-1");
    invoke.mockResolvedValue([{ ts: "2026-10-26T10:00:00Z", event: { type: "done", summary: "x" } }]);
    const log = await b.agentLog("s", "developer-1");
    expect(log[0].event.type).toBe("done");
    expect(invoke.mock.calls).toEqual([
      ["answer_agent", { spaceId: "s", agent: "developer-1", text: "keep it" }],
      ["cancel_agent", { spaceId: "s", agent: "developer-1" }],
      ["agent_log", { spaceId: "s", agent: "developer-1" }],
    ]);
  });

  it("subscribes to vela://agent and unsubscribes", async () => {
    const seen: AgentNotice[] = [];
    const off = b.onAgent((e) => seen.push(e));
    await Promise.resolve();
    const notice: AgentNotice = { spaceId: "s", agentId: "developer-1", event: { type: "message", text: "hi" } };
    listeners.get(AGENT_EVENT)?.({ payload: notice });
    expect(seen).toEqual([notice]);
    off();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalled();
  });

  describe("askFix", () => {
    const hunk = (origin: Hunk["origin"]): Hunk => ({
      id: "h1",
      repo: "api",
      path: "src/webhook.ts",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      section: "",
      lines: [],
      origin,
      state: "pending",
    });
    const note = { hunkId: "h1", by: "Reviewer · Codex", text: "Return 400 on a bad signature", resolved: false, busy: false };

    it("sends the reviewer note to the author of the proposal, on the author's harness", async () => {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "hunks") return [hunk({ type: "agent", agent: "developer-1" })];
        if (cmd === "notes") return [note];
        if (cmd === "agents") return [agent({ tool: "codex" })];
        return agent();
      });
      await b.askFix("s", "h1");
      const ask = invoke.mock.calls.find((c) => c[0] === "ask_agent");
      expect(ask?.[1]).toMatchObject({ spaceId: "s", role: "developer", harness: "codex", tier: null });
      expect(ask?.[1].prompt).toContain("Return 400 on a bad signature");
      expect(ask?.[1].prompt).toContain("src/webhook.ts");
    });

    it("refuses a hunk of yours and a proposal without a note", async () => {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "hunks") return [hunk({ type: "you" })];
        if (cmd === "notes") return [];
        return [];
      });
      await expect(b.askFix("s", "h1")).rejects.toThrow(/agent's proposal/);
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "hunks") return [hunk({ type: "agent", agent: "developer-1" })];
        return [];
      });
      await expect(b.askFix("s", "h1")).rejects.toThrow(/no reviewer note/);
      expect(invoke.mock.calls.some((c) => c[0] === "ask_agent")).toBe(false);
    });
  });
});
