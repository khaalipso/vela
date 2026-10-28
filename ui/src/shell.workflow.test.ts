// @vitest-environment jsdom
// Find, Markdown preview, terminal, side by side review, notes, tier settings, repo colors.
import { EditorView } from "@codemirror/view";
import { mount, tick, unmount } from "svelte";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";
import { app } from "./lib/app.svelte";
import { MockBackend } from "./lib/backend";
import { colorOfRepo } from "./lib/colors";

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
const backend = new MockBackend({ speed: 0 });

beforeAll(async () => {
  Element.prototype.scrollIntoView = () => {};
  // jsdom has no layout; CodeMirror measures text ranges.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as never;
  await app.init(backend);
  app.filesOpen = false;
  component = mount(App, { target: document.body });
  await settle();
});
afterAll(() => {
  void unmount(component);
  app.destroy();
});

describe("code view", () => {
  it("Ctrl F opens the find bar of the editor", async () => {
    const f = app.sd.files.find((x) => x.path.endsWith(".ts"))!;
    app.openFile(app.active, `${f.repo}/${f.path}`, true);
    await vi.waitFor(() => expect($(".cm-editor")).toBeTruthy());
    await settle();
    press("f", { ctrlKey: true });
    await vi.waitFor(() => expect($(".cm-search input[name='search']")).toBeTruthy());
    press("Escape", {}, document.activeElement!);
    await settle();
  });

  it("tabs take the color of their repo", async () => {
    const tab = $(".tabs .tab[aria-selected='true']")!;
    const repo = app.cui.file.split("/")[0];
    expect(tab.style.getPropertyValue("--rc")).toBe(colorOfRepo(app.space, repo));
  });

  it("a Markdown file opens as a preview, V shows the source, Ctrl F finds in the preview", async () => {
    const repo = app.space.repos[0].name;
    app.openFile(app.active, `${repo}/README.md`, true);
    await vi.waitFor(() => expect($("article.md h1")).toBeTruthy());
    expect($(".code")?.classList.contains("hidden")).toBe(true);
    press("f", { ctrlKey: true });
    await vi.waitFor(() => expect($(".find input")).toBeTruthy());
    const input = $(".find input") as HTMLInputElement;
    input.value = "notes";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect($$("mark.find").length).toBeGreaterThan(0);
    expect($(".find .count")?.textContent).toMatch(/1 of \d+/);
    press("Escape", {}, input);
    await settle();
    expect($$("mark.find").length).toBe(0);
    press("v");
    await settle();
    expect($("article.md")).toBeNull();
    expect($(".code")?.classList.contains("hidden")).toBe(false);
    expect(EditorView.findFromDOM($(".cm-editor")!)!.state.doc.toString()).toContain("# README");
    press("v");
    await settle();
    expect($("article.md")).toBeTruthy();
  });
});

describe("terminal", () => {
  it("T opens a terminal in the space; its output and input go through the backend", async () => {
    press("t");
    await vi.waitFor(() => expect($("section[aria-label='Terminal']")).toBeTruthy());
    await vi.waitFor(() => expect(app.spaceTerms.length).toBe(1));
    const id = app.spaceTerms[0].id;
    let out = "";
    app.attachTerm(id, (d) => (out += d));
    await vi.waitFor(() => expect(out).toContain("mock shell in"));
    await backend.termWrite(id, "pwd\r");
    await vi.waitFor(() => expect(out).toContain(app.space.repos[0].worktree));
    press("`", { ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(app.spaceTerms.length).toBe(2));
    expect($$("section[aria-label='Terminal'] .tab").length).toBe(2);
  });

  it("closing the last terminal hides the panel", async () => {
    for (const t of [...app.spaceTerms]) await app.closeTerminal(t.id);
    await settle();
    expect($("section[aria-label='Terminal']")).toBeNull();
    expect(app.termOpen).toBe(false);
  });
});

describe("review", () => {
  it("V shows the diff before and after side by side", async () => {
    press("2");
    await settle();
    const proposed = app.rows.find((r) => r.agents.length > 0)!;
    app.rvSelect(proposed.id);
    await settle();
    expect($(".cm-mergeView")).toBeNull();
    press("v");
    await settle();
    expect($$(".cm-mergeView .cm-editor").length).toBe(2);
    expect(app.view).toBe("review");
    press("v");
    await settle();
    expect($(".cm-mergeView")).toBeNull();
  });

  it("a note shows on its hunk; Shift Y resolves it and Reopen opens it again", async () => {
    const n = app.sd.notes[0];
    const row = app.rows.find((r) => r.repo === n.repo && r.path === n.path)!;
    app.rvSelect(row.id);
    await settle();
    expect($(`[data-note='${n.id}']`)?.textContent).toContain(n.text);
    const i = app.selectedHunks.findIndex((h) => h.id === n.hunkId);
    app.rvHunkSet(Math.max(0, i));
    await settle();
    press("Y", { shiftKey: true });
    await vi.waitFor(() => expect(app.sd.notes[0].resolved).toBe(true));
    await settle();
    expect($(`[data-note='${n.id}']`)?.classList.contains("resolved")).toBe(true);
    $$(`[data-note='${n.id}'] button`).find((b) => b.textContent?.includes("Reopen"))!.click();
    await vi.waitFor(() => expect(app.sd.notes[0].resolved).toBe(false));
  });
});

describe("agent tiers", () => {
  it("the settings sheet saves the model and effort of a tier", async () => {
    await app.dispatch({ type: "open-settings" });
    await settle();
    expect($("[aria-label='Agent tiers']")).toBeTruthy();
    const model = $("[aria-label='Claude Code high model']") as HTMLInputElement;
    model.value = "opus";
    model.dispatchEvent(new Event("change", { bubbles: true }));
    const effort = $("[aria-label='Claude Code high effort']") as HTMLSelectElement;
    effort.value = "max";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(async () => {
      const t = (await backend.agentTiers()).find((h) => h.harness === "claude")!.tiers[0];
      expect(t).toEqual({ tier: "high", model: "opus", effort: "max" });
    });
    // Letters typed in the sheet do not run shell actions.
    press("t");
    await settle();
    expect(app.termOpen).toBe(false);
    press("Escape");
    await settle();
    expect(app.overlay).toBeNull();
  });
});

describe("agent settings open at once", () => {
  it("the sheet shows before the backend answers, then fills in", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = vi.spyOn(backend, "agentTiers").mockImplementation(async () => {
      await gate;
      slow.mockRestore();
      return backend.agentTiers();
    });
    app.tierSettings = [];
    await app.dispatch({ type: "open-settings" });
    await tick();
    expect($("[aria-label='Agent settings']")).toBeTruthy();
    expect($(".skel")).toBeTruthy();
    release();
    await vi.waitFor(() => expect($("[aria-label='Claude Code high model']")).toBeTruthy());
    press("Escape");
    await settle();
  });

  it("the Prompts tab edits the brief of a role and resets it", async () => {
    await app.dispatch({ type: "open-prompts" });
    await vi.waitFor(() => expect($("textarea[aria-label$='brief']")).toBeTruthy());
    $$(".roles button").find((b) => b.textContent?.includes("Security"))!.click();
    await settle();
    const ta = $("textarea[aria-label='Security brief']") as HTMLTextAreaElement;
    expect(ta.value).toContain("security");
    ta.value = "Audit like a pentester.";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    press("s", { ctrlKey: true }, ta);
    await vi.waitFor(async () => expect((await backend.agentPrompts()).find((p) => p.role === "security")?.custom).toBe("Audit like a pentester."));
    await settle();
    expect($$(".roles button").find((b) => b.textContent?.includes("Security"))?.textContent).toContain("edited");
    $$(".acts button").find((b) => b.textContent?.includes("Reset"))!.click();
    await vi.waitFor(async () => expect((await backend.agentPrompts()).find((p) => p.role === "security")?.custom).toBeNull());
    press("Escape");
    await settle();
  });
});

describe("pull requests", () => {
  it("4 shows the PR of each repo with reviews, line comments and checks", async () => {
    press("4");
    await vi.waitFor(() => expect($("[data-repo]")).toBeTruthy());
    const first = $(`[data-repo='${app.space.repos[0].name}']`)!;
    expect(first.textContent).toContain("#412");
    expect(first.textContent).toContain("Changes requested");
    expect(first.textContent).toContain("requested changes");
    expect(first.querySelector(".thread .loc")?.textContent).toContain("src/billing/webhook.ts:12");
    expect([...first.querySelectorAll(".ck .cs")].map((e) => e.textContent)).toEqual(["pass", "fail", "pending"]);
    expect(app.prAttention).toBe(1);
  });

  it("a line comment opens its file, or goes to a developer agent", async () => {
    const ask = vi.spyOn(backend, "askAgent");
    const first = $(`[data-repo='${app.space.repos[0].name}']`)!;
    [...first.querySelectorAll<HTMLElement>(".thread button")].find((b) => b.textContent?.includes("Ask an agent"))!.click();
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    expect(ask.mock.calls[0][1]).toBe("developer");
    expect(ask.mock.calls[0][2]).toContain("Return 400 here");
    expect(ask.mock.calls[0][2]).toContain("src/billing/webhook.ts:12");
    ask.mockRestore();
    first.querySelector<HTMLElement>(".thread .loc")!.click();
    await settle();
    expect(app.view).toBe("code");
    expect(app.cui.file).toBe(`${app.space.repos[0].name}/src/billing/webhook.ts`);
  });

  it("comments go to the PR; a repo without one offers to open it", async () => {
    press("4");
    await vi.waitFor(() => expect($("[data-repo]")).toBeTruthy());
    const repo = app.space.repos[0].name;
    const ta = $(`textarea[aria-label='Comment on ${repo}']`) as HTMLTextAreaElement;
    ta.value = "Fixed in the last commit";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    press("Enter", { ctrlKey: true }, ta);
    await vi.waitFor(() => expect($(`[data-repo='${repo}']`)?.textContent).toContain("Fixed in the last commit"));
    if (app.space.repos.length > 1) {
      const other = app.space.repos[1].name;
      expect($(`[data-repo='${other}'] .none`)).toBeTruthy();
      $$(`[data-repo='${other}'] .none button`)[0].click();
      await vi.waitFor(() => expect($(`[data-repo='${other}']`)?.textContent).toContain("#413"));
    }
  });
});

describe("agents view", () => {
  it("Edit and rerun opens the composer with the request", async () => {
    press("3");
    await settle();
    const done = app.sd.agents.find((a) => a.status === "done")!;
    app.data = {
      ...app.data,
      [app.space.id]: { ...app.sd, agents: app.sd.agents.map((a) => (a.id === done.id ? { ...a, prompt: "Write the tests" } : a)) },
    };
    app.selectAgent(done.id);
    await settle();
    $$(".chat .ch button").find((b) => b.textContent?.includes("Edit and rerun"))!.click();
    await settle();
    expect(app.overlay).toBe("composer");
    expect(app.role).toBe(done.role);
    expect(app.harness).toBe(done.tool);
    expect(app.composerText).toBe("Write the tests");
    press("Escape");
    await settle();
  });
});

describe("your changes in the code view", () => {
  it("bars in the gutter open a peek to stage and revert, with an undo", async () => {
    press("1");
    await settle();
    // A file with no proposal in it, so only your change shows.
    const f = app.sd.files.find(
      (x) => !x.path.endsWith(".md") && !app.sd.hunks.some((h) => h.repo === x.repo && h.path === x.path),
    )!;
    const repo = f.repo;
    const file = f.path;
    app.openFile(app.active, `${repo}/${file}`, true);
    await vi.waitFor(() => expect($(".cm-editor")).toBeTruthy());
    await settle();
    const before = (await backend.readFile(app.space.id, repo, file)).content;
    await backend.writeFile(app.space.id, repo, file, `// added by hand\n${before}`);
    await app.refresh();
    await vi.waitFor(() => expect($$(".cm-change-gutter .cm-chg-unstaged").length).toBeGreaterThan(0));
    expect($(".chgbar")?.textContent).toContain("1 not staged");
    // Click the bar: the peek opens under the change.
    const bar = $(".cm-change-gutter .cm-chg-unstaged")!.parentElement!;
    bar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await vi.waitFor(() => expect($(".cm-peek .peek")).toBeTruthy());
    expect($(".cm-peek .peek")?.textContent).toContain("Not staged");
    $$(".cm-peek button").find((b) => b.textContent === "Stage")!.click();
    await vi.waitFor(() => expect($(".chgbar")?.textContent).toContain("1 staged"));
    await vi.waitFor(() => expect($$(".cm-change-gutter .cm-chg-staged").length).toBeGreaterThan(0));
    await vi.waitFor(() => expect($(".cm-peek .peek")?.textContent).toContain("Staged"));
    $$(".cm-peek button").find((b) => b.textContent === "Revert")!.click();
    await vi.waitFor(() => expect(app.toastState?.action?.label).toBe("Undo"));
    expect((await backend.readFile(app.space.id, repo, file)).content).toBe(before);
    expect($(".chgbar")).toBeNull();
    app.toastState!.action!.run();
    await vi.waitFor(async () =>
      expect((await backend.readFile(app.space.id, repo, file)).content).toContain("// added by hand"),
    );
  });

  it("Ctrl Alt Down goes to the next change and opens it", async () => {
    await vi.waitFor(() => expect($(".chgbar")).toBeTruthy());
    press("ArrowDown", { ctrlKey: true, altKey: true });
    await vi.waitFor(() => expect($(".cm-peek .peek")).toBeTruthy());
    press("Escape", {}, $(".cm-content")!);
    await settle();
    expect($(".cm-peek .peek")).toBeNull();
  });
});

describe("branches", () => {
  it("a new space takes the branch you type and a base, or an existing branch", async () => {
    const create = vi.spyOn(backend, "createSpace");
    await app.dispatch({ type: "open-newspace" });
    await settle();
    app.newSp.name = "Export button";
    app.newSp.repos = ["api"];
    await settle();
    // The default comes from the pattern.
    expect($$(".link").some((b) => b.textContent?.includes("feat/export-button"))).toBe(true);
    $$(".link").find((b) => b.textContent?.includes("feat/export-button"))!.click();
    await settle();
    const br = $("#ns-branch") as HTMLInputElement;
    br.value = "origin/feat/teammate-pr";
    br.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect($("[data-branch-hint]")?.textContent).toContain("local branch that tracks it"));
    expect(($("#ns-base") as HTMLInputElement).disabled).toBe(true);
    br.value = "louis/export";
    br.dispatchEvent(new Event("input", { bubbles: true }));
    const base = $("#ns-base") as HTMLInputElement;
    base.value = "develop";
    base.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect($("[data-branch-hint]")?.textContent).toContain("A new branch louis/export, from develop");
    await app.dispatch({ type: "newspace-submit" });
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][2]).toEqual({ branch: "louis/export", base: "develop" });
    await vi.waitFor(() => expect(app.space.branch).toBe("louis/export"));
    expect($(".top .branch")?.textContent).toContain("louis/export");
    create.mockRestore();
  });

  it("the branch chip renames the branch and pushes it", async () => {
    $(".top .branch")!.click();
    await settle();
    [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((m) => m.textContent?.includes("Rename branch"))!.click();
    await settle();
    const input = document.querySelector<HTMLInputElement>(".sheet input")!;
    input.value = "bad name";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.form!.requestSubmit();
    await settle();
    expect(document.querySelector(".sheet")?.textContent).toContain("Git does not take this name");
    expect(app.space.branch).toBe("louis/export");
    input.value = "louis/export-csv";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    input.form!.requestSubmit();
    await vi.waitFor(() => expect(app.space.branch).toBe("louis/export-csv"));
    $(".top .branch")!.click();
    await settle();
    [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((m) => m.textContent?.includes("Push branch"))!.click();
    await vi.waitFor(() => expect(backend.pushed).toContain("louis/export-csv"));
  });

  it("the Branches settings change the pattern of new spaces", async () => {
    await app.dispatch({ type: "open-branch-settings" });
    await vi.waitFor(() => expect($("[aria-label='Branch pattern']")).toBeTruthy());
    const p = $("[aria-label='Branch pattern']") as HTMLInputElement;
    p.value = "{user}/{slug}";
    p.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect($(".preview")?.textContent).toContain("/refunds-in-checkout");
    $$(".branches .btn.p")[0].click();
    await vi.waitFor(() => expect(app.branchTemplate).toBe("{user}/{slug}"));
    press("Escape");
    await settle();
  });
});
