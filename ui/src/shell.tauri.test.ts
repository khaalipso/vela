// @vitest-environment jsdom
// The whole shell on the TauriBackend, with a fake Rust side behind a mocked `invoke`.
// Checks that the UI renders and works with no space, no agents, no notes, no stack, no gate.
import { mount, tick, unmount } from "svelte";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Json = Record<string, unknown>;

const calls: [string, Json | undefined][] = [];
const fake = {
  spaces: [] as Json[],
  staged: false,
  fail: null as string | null,
};

const hunk = (state: string): Json => ({
  id: "h1",
  repo: "api",
  path: "src/a.ts",
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  section: "",
  lines: [
    { kind: "del", text: "old", old: 1, new: null },
    { kind: "add", text: "new", old: null, new: 1 },
  ],
  origin: { type: "you" },
  state,
});

function rust(cmd: string, args?: Json): unknown {
  calls.push([cmd, args]);
  if (fake.fail === cmd) throw { kind: "git", message: "git exploded" };
  switch (cmd) {
    case "list_repos":
      return ["/w/api", "/w/web"];
    case "list_spaces":
      return structuredClone(fake.spaces); // like the wire: a fresh array each call
    case "create_space": {
      const s = {
        id: "fix-it",
        name: args!.name,
        color: "#E8A14A",
        branch: "feat/fix-it",
        repos: (args!.repos as string[]).map((r) => ({ name: r.split("/").pop(), source: r, worktree: `/h/${r}`, base: "main" })),
        createdAt: "2026-10-26T10:00:00Z",
        window: null,
        archived: false,
      };
      fake.spaces.push(s);
      return s;
    }
    case "set_window":
    case "open_space_window":
      fake.spaces[0].window = cmd === "set_window" ? args!.window : 2;
      return null;
    case "status":
      return [{ repo: "api", path: "src/a.ts", staged: fake.staged ? "modified" : null, unstaged: fake.staged ? null : "modified" }];
    case "hunks":
      return [hunk(fake.staged ? "staged" : "pending")];
    case "list_files":
      return [{ repo: "api", path: "src/a.ts" }];
    case "read_file":
      return "const a = 1;\nconst b = 2;\n";
    case "write_file":
      return null;
    case "stage_hunk":
      fake.staged = true;
      return hunk("staged");
    case "draft_commit":
      return "Fix it";
    case "commit":
      fake.staged = false;
      return { repos: ["api"], branch: "feat/fix-it" };
    case "reasons":
      return {};
    case "question":
      return null;
    case "run_gate":
      return [];
    default:
      return []; // agents, notes, stack
  }
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Json) => rust(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import App from "./App.svelte";
import { app } from "./lib/app.svelte";
import { TauriBackend } from "./lib/backend";

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const press = (key: string, o: KeyboardEventInit = {}, target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...o }));
const settle = async () => {
  await tick();
  await new Promise((r) => setTimeout(r, 5));
  await tick();
};

let component: ReturnType<typeof mount>;

beforeAll(async () => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => {};
  await app.init(new TauriBackend());
  component = mount(App, { target: document.body });
  await settle();
});
afterAll(() => {
  void unmount(component);
  app.destroy();
});

describe("shell on the Tauri backend", () => {
  it("shows an empty state with no space and ignores keys", async () => {
    expect($(".empty h1")?.textContent).toBe("No space yet");
    press("1");
    press("j");
    press("y");
    await settle();
    expect($(".empty")).toBeTruthy();
    expect($$(".toast").length).toBe(0);
  });

  it("creates the first space from the sheet, repos shown by directory name", async () => {
    $(".empty button")!.click();
    await settle();
    expect($$(".rtog").map((b) => b.textContent)).toEqual(["api", "web"]);
    expect($$(".rtog")[0].getAttribute("title")).toBe("/w/api");
    expect(app.newSp.repos).toEqual([]);
    app.newSp.name = "Fix it";
    $$(".rtog")[0].click();
    await settle();
    await app.dispatch({ type: "newspace-submit" });
    await settle();
    expect(calls.find((c) => c[0] === "create_space")![1]).toEqual({ name: "Fix it", repos: ["/w/api"] });
    expect($("h1")?.textContent).toContain("Fix it");
    expect(app.view).toBe("code");
    expect(document.documentElement.style.getPropertyValue("--space")).toBe("#E8A14A");
  });

  it("renders every view with no agents, notes, question or stack", async () => {
    for (const k of ["3", "2", "1"]) {
      press(k);
      await settle();
      expect($(".surface")).toBeTruthy();
    }
    press("s");
    await settle();
    press("Escape");
    await settle();
    expect(app.sd.agents).toEqual([]);
    expect(app.proposals).toEqual([]);
    // Your own pending hunk shows in the drawer.
    press("b");
    await settle();
    expect($(".changes")?.textContent).toContain("a.ts");
    press("b");
  });

  it("commits with an empty gate, without claiming a push", async () => {
    fake.staged = true;
    await app.load("fix-it");
    press("c");
    await settle();
    await vi.waitFor(() => expect(app.gate?.done).toBe(true));
    await settle();
    expect($(".checks")?.textContent).toContain("No gate checks yet");
    const btn = $$(".sheet .btn.p")[0] as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await app.dispatch({ type: "commit-submit" });
    await settle();
    expect(calls.filter((c) => c[0] === "commit").at(-1)![1]).toMatchObject({ spaceId: "fix-it", message: "Fix it" });
    expect($(".toast")?.textContent).toBe("Committed api on feat/fix-it");
  });

  it("shows backend errors as a toast with the message", async () => {
    fake.fail = "write_file";
    await app.writeFile("api", "src/a.ts", "x");
    await settle();
    expect($(".toast")?.textContent).toBe("git exploded");
    fake.fail = null;
  });

  it("W opens the space window; a pinned window shows its space, not the placeholder", async () => {
    await app.dispatch({ type: "toggle-window" });
    await settle();
    expect(calls.at(-1)![0]).not.toBe("set_window");
    expect(calls.some((c) => c[0] === "open_space_window" && c[1]?.spaceId === "fix-it")).toBe(true);
    expect(app.elsewhere).toBe(true);
    expect($(".elsewhere h3")?.textContent).toContain("open in window 2");

    await app.init(new TauriBackend(), "fix-it");
    await settle();
    expect(app.spaces.map((s) => s.id)).toEqual(["fix-it"]);
    expect(app.elsewhere).toBe(false);
    expect($(".elsewhere")).toBeNull();
    expect($("h1")?.textContent).toContain("Fix it");

    // Pinned to a space that does not exist: the empty state, no crash.
    await app.init(new TauriBackend(), "ghost");
    await settle();
    expect($(".empty h1")?.textContent).toBe("This space is gone");
  });
});
