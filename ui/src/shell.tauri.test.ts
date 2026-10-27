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
  links: [] as Json[],
};

const hunk = (state: string, id = "h1", path = "src/a.ts"): Json => ({
  id,
  repo: "api",
  path,
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
    case "hunks": {
      const st = fake.staged ? "staged" : "pending";
      return [hunk(st), hunk(st, "h2", "src/b.ts"), hunk(st, "h3", "tests/a.test.ts")];
    }
    case "list_files":
      return [{ repo: "api", path: "src/a.ts" }];
    case "space_files":
      return [{ repo: "api", branch: "feat/fix-it", worktree: "/h/api", ahead: null, behind: null, truncated: false, files: [{ path: "src/a.ts", staged: null, unstaged: "modified" }, { path: "src/b.ts", staged: null, unstaged: null }] }];
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
    case "commit_plan":
      return {
        conventional: true,
        rules: { types: ["feat", "fix", "perf", "test", "docs"], scopes: [], headerMax: 72 },
        groups: [
          { id: "g1", repo: "api", kind: "fix", scope: null, breaking: false, breakingReason: null, subject: "update a and b", body: "", footers: ["Refs: PAY-1"], hunks: ["h1", "h2"] },
          { id: "g2", repo: "api", kind: "test", scope: "a", breaking: false, breakingReason: null, subject: "cover a", body: "", footers: ["Refs: PAY-1"], hunks: ["h3"] },
        ],
      };
    case "validate_message":
      return (args!.message as string).includes("perf")
        ? [{ field: "type", message: "Type perf is not allowed here" }]
        : [];
    case "commit_groups":
      fake.staged = false;
      return {
        repos: ["api"],
        branch: "feat/fix-it",
        commits: (args!.groups as Json[]).map((g, i) => ({ group: g.id, repo: g.repo, sha: `abc${i}` })),
      };
    case "links":
      return structuredClone(fake.links);
    case "add_link": {
      const l = {
        id: `l${fake.links.length + 1}`,
        kind: "other",
        provider: "url",
        url: args!.url,
        title: args!.title ?? "added",
        key: null,
        source: args!.source ?? "manual",
      };
      fake.links.push(l);
      return l;
    }
    case "remove_link":
      fake.links = fake.links.filter((l) => l.id !== args!.linkId);
      return null;
    case "open_url":
      return null;
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
  app.filesOpen = false;
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
    expect(calls.find((c) => c[0] === "create_space")![1]).toEqual({ name: "Fix it", repos: ["/w/api"], branch: null, base: null });
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
    await vi.waitFor(() => expect($(".files")?.textContent).toContain("api"));
    press("b");
  });

  const openComposer = async () => {
    fake.staged = true;
    await app.load("fix-it");
    press("c");
    await settle();
    await vi.waitFor(() => expect(app.gate?.done).toBe(true));
    await settle();
  };

  it("composer: a bad header blocks the commit until it is fixed", async () => {
    await openComposer();
    expect(calls.filter((c) => c[0] === "commit_plan").length).toBeGreaterThan(0);
    expect($$(".card").length).toBe(2);
    expect($$(".card .prev").map((e) => e.textContent)).toEqual(["fix: update a and b", "test(a): cover a"]);
    expect($$(".pill").map((e) => e.textContent)).toEqual(["fix", "test"]);
    // The focused commit shows its hunks.
    expect($$(".card.focus .hk .p").map((e) => e.textContent)).toEqual(["src/a.ts", "src/b.ts"]);

    // T cycles the type; the backend says perf is not allowed.
    press("t");
    await vi.waitFor(() => expect(app.cc!.problems.g1?.length).toBe(1));
    await settle();
    expect($(".card.focus .probs")?.textContent).toContain("Type perf is not allowed here");
    expect($(".card.focus .prev")?.textContent).toBe("perf: update a and b");
    expect(($$(".sheet .btn.p")[0] as HTMLButtonElement).disabled).toBe(true);
    const before = calls.filter((c) => c[0] === "commit_groups").length;
    await app.dispatch({ type: "commit-submit" });
    expect(app.toastState?.text).toBe("Fix the highlighted messages first");
    expect(calls.filter((c) => c[0] === "commit_groups").length).toBe(before);

    // Nine more presses go round the types allowed by the rules, back to fix.
    for (let i = 0; i < 9; i++) press("t");
    await vi.waitFor(() => expect(app.cc!.groups[0].kind).toBe("fix"));
    await vi.waitFor(() => expect(app.cc!.problems.g1?.length).toBe(0));
    await settle();
    expect($(".card.focus .probs")).toBeNull();

    // In the subject field single letters do not act; Esc leaves the field, the next Esc closes.
    const subject = $('.card.focus [data-field="subject"]') as HTMLInputElement;
    subject.focus();
    subject.value = "update everything";
    subject.dispatchEvent(new Event("input", { bubbles: true }));
    press("t", {}, subject);
    await settle();
    expect(app.cc!.groups[0].kind).toBe("fix");
    expect($(".card.focus .prev")?.textContent).toBe("fix: update everything");
    press("Escape", {}, subject);
    await settle();
    expect(app.overlay).toBe("commit");
    subject.blur();
    press("Escape");
    await settle();
    expect(app.overlay).toBeNull();
    expect(app.gate).toBeNull();
  });

  it("composer: ! marks a breaking change and sends the reason", async () => {
    await openComposer();
    press("!");
    await settle();
    expect($(".card.focus .prev")?.textContent).toBe("fix!: update a and b");
    const reason = $('.card.focus [data-field="reason"]') as HTMLInputElement;
    reason.value = "`a` removed";
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    await app.dispatch({ type: "commit-submit" });
    await settle();
    const last = calls.filter((c) => c[0] === "commit_groups").at(-1)![1] as Json;
    expect((last.groups as Json[])[0]).toMatchObject({ breaking: true, breakingReason: "`a` removed" });
  });

  it("composer: 1 to 9 move hunks, G splits one off, M merges, ] changes the commit", async () => {
    await openComposer();
    const hunks = () => app.cc!.groups.map((g) => g.hunks);
    press("2");
    await settle();
    expect(hunks()).toEqual([["h2"], ["h3", "h1"]]);
    // The focus stays on the first commit, which now has one hunk.
    expect(app.cc!.gi).toBe(0);
    press("g");
    expect(app.toastState?.text).toBe("This commit has only one hunk");
    press("9");
    expect(app.toastState?.text).toBe("There is no commit 9");
    press("]");
    await settle();
    expect(app.cc!.gi).toBe(1);
    press("j");
    await settle();
    expect(app.cc!.hi).toBe(1);
    expect($$(".card.focus .hunks li.sel .p").map((e) => e.textContent)).toEqual(["src/a.ts"]);
    press("g");
    await settle();
    expect(hunks()).toEqual([["h2"], ["h3"], ["h1"]]);
    expect($$(".card").length).toBe(3);
    expect(app.cc!.gi).toBe(2);
    press("m");
    await settle();
    expect($$(".card").length).toBe(1);
    expect([...app.cc!.groups[0].hunks].sort()).toEqual(["h1", "h2", "h3"]);
    press("m");
    expect(app.toastState?.text).toBe("Already one commit per repo");
    await app.dispatch({ type: "commit-submit" });
    await settle();
    const last = calls.filter((c) => c[0] === "commit_groups").at(-1)![1] as Json;
    expect(last).toMatchObject({ spaceId: "fix-it", conventional: true, overrideReason: null });
    expect(last.groups as Json[]).toHaveLength(1);
    expect($(".toast")?.textContent).toBe("Committed 1 commit on feat/fix-it");
  });

  it("commits every commit in order with an empty gate, without claiming a push", async () => {
    await openComposer();
    expect($(".checks")?.textContent).toContain("No checks configured");
    const btn = $$(".sheet .btn.p")[0] as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain("Commit 2 commits");
    await app.dispatch({ type: "commit-submit" });
    await settle();
    const last = calls.filter((c) => c[0] === "commit_groups").at(-1)![1] as Json;
    expect((last.groups as Json[]).map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(last.groups).toMatchObject([{ subject: "update a and b", footers: ["Refs: PAY-1"] }, { subject: "cover a" }]);
    expect($(".toast")?.textContent).toBe("Committed 2 commits on feat/fix-it");
  });

  it("links: a pasted URL is linked, L lists it, Enter opens it, Backspace removes it", async () => {
    const paste = (text: string, target: EventTarget = document.body) => {
      const e = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "clipboardData", { value: { getData: () => text } });
      target.dispatchEvent(e);
      return e;
    };
    expect(paste("just words").defaultPrevented).toBe(false);
    expect(paste("javascript:alert(1)").defaultPrevented).toBe(false);
    expect(calls.some((c) => c[0] === "add_link")).toBe(false);
    expect(paste("  https://staging.acme.dev/billing \n").defaultPrevented).toBe(true);
    await settle();
    expect(calls.filter((c) => c[0] === "add_link").at(-1)![1]).toMatchObject({
      spaceId: "fix-it",
      url: "https://staging.acme.dev/billing",
      source: "paste",
    });
    expect($(".toast")?.textContent).toBe("Linked added");
    expect(app.links.map((l) => l.url)).toEqual(["https://staging.acme.dev/billing"]);
    expect($$(".lk").length).toBe(1);

    // Not while typing in a field.
    const input = document.createElement("input");
    document.body.append(input);
    expect(paste("https://elsewhere.dev", input).defaultPrevented).toBe(false);
    input.remove();

    press("l");
    await settle();
    expect(app.overlay).toBe("links");
    expect($$(".sheet .pit").length).toBe(1);
    // The URL field has the focus; Enter adds what is typed.
    const field = $("#links-in") as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    field.value = "https://acme.dev/doc";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect($(".preview")?.textContent).toContain("acme.dev/doc");
    press("Enter", {}, field);
    await settle();
    expect(calls.filter((c) => c[0] === "add_link").at(-1)![1]).toMatchObject({ url: "https://acme.dev/doc", source: "manual" });
    expect($$(".sheet .pit").length).toBe(2);
    // Esc leaves the field and keeps the sheet; Enter then opens the selected link.
    press("Escape", {}, field);
    field.blur();
    await settle();
    expect(app.overlay).toBe("links");
    press("Enter");
    await settle();
    expect(calls.filter((c) => c[0] === "open_url").at(-1)![1]).toEqual({ url: app.orderedLinks[app.linksUi.i].url });
    press("Backspace");
    await settle();
    expect(calls.some((c) => c[0] === "remove_link")).toBe(true);
    expect($$(".sheet .pit").length).toBe(1);
    press("Escape");
    await settle();
    expect(app.overlay).toBeNull();
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
  app.filesOpen = false;
    await settle();
    expect(app.spaces.map((s) => s.id)).toEqual(["fix-it"]);
    expect(app.elsewhere).toBe(false);
    expect($(".elsewhere")).toBeNull();
    expect($("h1")?.textContent).toContain("Fix it");

    // Pinned to a space that does not exist: the empty state, no crash.
    await app.init(new TauriBackend(), "ghost");
  app.filesOpen = false;
    await settle();
    expect($(".empty h1")?.textContent).toBe("This space is gone");
  });
});
