// @vitest-environment jsdom
// The composer's harness and tier pickers and the agents view, through the whole shell on the
// mock backend, driven by synthetic key events and clicks. No screen involved.
import { mount, tick, unmount } from "svelte";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";
import { app } from "./lib/app.svelte";
import { MockBackend } from "./lib/backend";
import type { Agent } from "./lib/types";

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const press = (key: string, o: KeyboardEventInit = {}, target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...o }));
const settle = async () => {
  await tick();
  await new Promise((r) => setTimeout(r, 5));
  await tick();
};
const pressed = (sel: string) => $$(sel).filter((e) => e.getAttribute("aria-pressed") === "true").map((e) => e.textContent?.trim());

const backend = new MockBackend({ speed: 0 });
let component: ReturnType<typeof mount>;

beforeAll(async () => {
  Element.prototype.scrollIntoView = () => {};
  await app.init(backend);
  app.filesOpen = false;
  component = mount(App, { target: document.body });
  await settle();
});
afterAll(() => {
  void unmount(component);
  app.destroy();
});
beforeEach(async () => {
  app.overlay = null;
  app.harness = null;
  app.tier = null;
  app.role = "developer";
  await settle();
});

describe("composer pickers", () => {
  it("lists the installed harnesses only, with the role's default selected", async () => {
    press("@");
    await settle();
    expect(app.overlay).toBe("composer");
    // The mock has claude and codex installed, opencode missing.
    expect($$(".harness").map((e) => e.textContent?.trim())).toEqual(["Claude Code", "Codex"]);
    expect(pressed(".harness")).toEqual(["Claude Code"]);
    expect(pressed(".tier")).toEqual(["medium"]);
  });

  it("the tier default follows the role", async () => {
    press("@");
    await settle();
    press("Tab", {}, $("#cmp-in")!);
    await settle();
    expect(app.role).toBe("reviewer");
    expect(pressed(".tier")).toEqual(["high"]);
    app.role = "tester";
    await settle();
    expect(pressed(".tier")).toEqual(["low"]);
  });

  it("Shift Tab cycles the harness and Ctrl Up / Down the tier", async () => {
    press("@");
    await settle();
    const ta = $("#cmp-in")!;
    press("Tab", { shiftKey: true }, ta);
    await settle();
    expect(app.harness).toBe("codex");
    expect(pressed(".harness")).toEqual(["Codex"]);
    press("Tab", { shiftKey: true }, ta);
    await settle();
    expect(app.harness).toBe("claude");
    press("ArrowUp", { ctrlKey: true }, ta);
    await settle();
    expect(pressed(".tier")).toEqual(["high"]);
    press("ArrowUp", { ctrlKey: true }, ta);
    await settle();
    expect(pressed(".tier")).toEqual(["high"]);
    press("ArrowDown", { ctrlKey: true }, ta);
    press("ArrowDown", { ctrlKey: true }, ta);
    await settle();
    expect(pressed(".tier")).toEqual(["low"]);
    // Still the same role: only the pickers moved.
    expect(app.role).toBe("developer");
  });

  it("the chips are clickable and the choice goes with the request", async () => {
    const ask = vi.spyOn(backend, "askAgent");
    press("@");
    await settle();
    $$(".harness").find((e) => e.textContent?.trim() === "Codex")!.click();
    $$(".tier").find((e) => e.textContent?.trim() === "high")!.click();
    await settle();
    expect(pressed(".harness")).toEqual(["Codex"]);
    const ta = $("#cmp-in") as HTMLTextAreaElement;
    ta.value = "Handle charge.refunded";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    press("Enter", {}, ta);
    await settle();
    expect(ask).toHaveBeenCalledWith(expect.any(String), "developer", "Handle charge.refunded", { harness: "codex", tier: "high" });
    // The pick is for one request: the next composer starts from the role's default again.
    expect(app.harness).toBeNull();
    expect(app.tier).toBeNull();
    ask.mockRestore();
  });

  it("says plainly what a new worktree means", async () => {
    press("@");
    await settle();
    expect($(".composer .psec")?.textContent).toMatch(/uncommitted changes are not copied/);
    app.role = "reviewer";
    await settle();
    expect($(".composer .psec")?.textContent).toMatch(/changes nothing/);
  });
});

describe("agents view", () => {
  const withAgents = (agents: Agent[]) => {
    app.data = { ...app.data, [app.space.id]: { ...app.sd, agents, question: null } };
  };
  const live: Agent = {
    id: "developer-1",
    space: "s",
    role: "developer",
    tool: "claude",
    model: "opus",
    tier: "high",
    worktrees: [["api", "/h/worktrees/s/.agents/developer-1/api"]],
    status: "working",
    summary: "Reading the webhook",
    lastMessage: "Reading the webhook\nthen adding the refund branch",
    plan: ["Read the webhook", "Add the refund branch"],
    usage: { inputTokens: 2000, outputTokens: 340, costUsd: 0.0421 },
  };

  it("empty state lists the detected harnesses and how to ask", async () => {
    press("3");
    await settle();
    withAgents([]);
    await settle();
    const text = $(".ag .empty")?.textContent ?? "";
    expect(text).toContain("No agents yet");
    expect($$(".harnesses li").map((e) => e.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringContaining("Claude Code"),
      expect.stringContaining("Codex"),
      expect.stringContaining("opencode"),
    ]);
    expect($$(".harnesses li.off").length).toBe(1);
    expect($$(".ag button").some((b) => b.textContent?.includes("Ask an agent"))).toBe(true);
  });

  it("a running agent shows its status, streaming message, plan, usage and Cancel", async () => {
    const cancel = vi.spyOn(backend, "cancelAgent");
    press("3");
    await settle();
    withAgents([live]);
    await settle();
    const card = $(".agent")!;
    expect(card.textContent).toContain("working");
    expect(card.textContent).toContain("Claude Code · opus · high");
    expect($(".stream")?.textContent).toContain("then adding the refund branch");
    expect($$(".plan li").map((e) => e.textContent)).toEqual(["Read the webhook", "Add the refund branch"]);
    expect(card.textContent).toContain("2.0k in · 340 out · $0.04");
    expect($(".ag .total")?.textContent).toContain("1 agent ·");
    const btn = $$(".agent .actions button").find((b) => b.textContent?.trim() === "Cancel")!;
    btn.click();
    await settle();
    expect(cancel).toHaveBeenCalledWith(app.space.id, "developer-1");
    cancel.mockRestore();
  });

  it("a finished agent has no Cancel; View log loads and shows its history", async () => {
    const log = vi.spyOn(backend, "agentLog").mockResolvedValue([
      { ts: "t", event: { type: "prompt", text: "Handle charge.refunded" } },
      { ts: "t", event: { type: "toolCall", name: "Edit", summary: "src/webhook.ts" } },
      { ts: "t", event: { type: "usage", inputTokens: 1, outputTokens: 1, costUsd: null, model: "m" } },
      { ts: "t", event: { type: "done", summary: "ok" } },
    ]);
    press("3");
    await settle();
    withAgents([{ ...live, status: "done" }]);
    await settle();
    expect($$(".agent .actions button").map((b) => b.textContent?.trim())).toEqual(["View log"]);
    expect($(".stream")).toBeNull();
    $$(".agent .actions button")[0].click();
    await settle();
    expect(log).toHaveBeenCalledWith(app.space.id, "developer-1");
    expect($$(".log .line").map((e) => e.textContent)).toEqual(["Handle charge.refunded", "Edit src/webhook.ts", "Finished"]);
    $$(".agent .actions button")[0].click();
    await settle();
    expect($(".log")).toBeNull();
    log.mockRestore();
  });

  it("shows the total once there are agents with usage", async () => {
    press("3");
    await settle();
    withAgents([live, { ...live, id: "tester-1", role: "tester", status: "done" }]);
    await settle();
    expect($(".ag .total")?.textContent).toContain("2 agents");
    expect($(".ag .total")?.textContent).toContain("$0.08");
  });
});

describe("agent events", () => {
  it("reload the agents, the question and the reasons of the space they belong to", async () => {
    const { AppState } = await import("./lib/app.svelte");
    let emit: ((n: import("./lib/backend").AgentNotice) => void) | null = null;
    class Wired extends MockBackend {
      onAgent(l: (n: import("./lib/backend").AgentNotice) => void) {
        emit = l;
        return () => {};
      }
    }
    const b = new Wired({ speed: 0 });
    const state = new AppState();
    await state.init(b);
    const id = state.space.id;
    const agents = vi.spyOn(b, "agents");
    const question = vi.spyOn(b, "question");
    emit!({ spaceId: id, agentId: "developer-1", event: { type: "message", text: "hi" } });
    emit!({ spaceId: id, agentId: "developer-1", event: { type: "message", text: "hi again" } });
    // An unknown space is ignored.
    emit!({ spaceId: "nope", agentId: "x", event: { type: "message", text: "?" } });
    await new Promise((r) => setTimeout(r, 200));
    // Two events in a burst make one reload.
    expect(agents).toHaveBeenCalledTimes(1);
    expect(question).toHaveBeenCalledTimes(1);
    state.destroy();
  });
});
