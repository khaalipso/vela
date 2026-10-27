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

  describe("notes", () => {
    it("askFix and resolveNote go to their commands with the note id", async () => {
      invoke.mockResolvedValue(undefined);
      await b.askFix("s", "n1");
      await b.resolveNote("s", "n1", true);
      expect(invoke).toHaveBeenCalledWith("ask_fix", { spaceId: "s", noteId: "n1" });
      expect(invoke).toHaveBeenCalledWith("resolve_note", { spaceId: "s", noteId: "n1", resolved: true });
    });

    it("tier settings and terminals map to their commands", async () => {
      invoke.mockResolvedValue(7);
      await b.setAgentTier("claude", "high", "opus", "max");
      expect(invoke).toHaveBeenCalledWith("set_agent_tier", { harness: "claude", tier: "high", model: "opus", effort: "max" });
      expect(await b.termOpen("s", null, 80, 24)).toBe(7);
      expect(invoke).toHaveBeenCalledWith("term_open", { spaceId: "s", repo: null, cols: 80, rows: 24 });
      await b.termWrite(7, "ls\r");
      expect(invoke).toHaveBeenCalledWith("term_write", { id: 7, data: "ls\r" });
    });
  });
});
