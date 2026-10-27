// @vitest-environment jsdom
// The Review view end to end in jsdom: files, diff and checks, driven by synthetic key events
// on the mock backend. No screen involved.
import { mount, tick, unmount } from "svelte";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";
import { app } from "./lib/app.svelte";
import { MockBackend } from "./lib/backend";

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const press = (key: string, o: KeyboardEventInit = {}) =>
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...o }));
const settle = async () => {
  await tick();
  await new Promise((r) => setTimeout(r, 5));
  await tick();
};
const rows = (section: string) => $$(`[data-section='${section}'] .frow`).map((r) => r.dataset.row);
const summary = () => $(".summary .sum")?.textContent;
const check = (id: string) => $(`[data-check='${id}']`)!;
/** The file of the space with no proposal (the seed staged it before). */
const plain = async () => (await backend.listFiles("stripe")).find((f) => f.path.endsWith("checkout.ts"))!;

let component: ReturnType<typeof mount>;
const backend = new MockBackend({ speed: 0 });

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

describe("review: layout", () => {
  it("lists the files to review and the accepted ones, the diff of the selected file, and the checks", () => {
    expect($("section[aria-label='Files']")).toBeTruthy();
    expect($("section[aria-label='Diff']")).toBeTruthy();
    expect($("aside[aria-label='Checks']")).toBeTruthy();
    expect($$("[data-section]").map((s) => s.dataset.section)).toEqual(["review", "done"]);
    // the seed has one file staged earlier and two files with proposals
    expect($$(".sh .count").map((c) => c.textContent)).toEqual(["2", "1"]);
    expect($(".head")?.textContent).toContain("2 files to review");
    expect($(".head")?.textContent).toContain("1 of 3 accepted");
    // who proposes: an agent chip on the row
    expect($("[data-section='review'] .frow .chip")?.textContent).toBeTruthy();
  });

  it("Shift U takes every accepted file back to review", async () => {
    press("U", { shiftKey: true });
    await vi.waitFor(() => expect(rows("done")).toEqual([]));
    expect($("[data-section='done']")).toBeNull();
    expect(rows("review").length).toBe(3);
    expect($(".commit .btn.p")?.hasAttribute("disabled")).toBe(true);
  });

  it("the checks panel lists the checks of the space with a summary", () => {
    expect($$("[data-check]").map((e) => e.dataset.check)).toEqual(["pre-commit", "lint", "test"]);
    expect(summary()).toBe("0 of 2 passed · tests off");
    expect(check("test").dataset.status).toBe("disabled");
    expect($$(".toggle").length).toBe(1);
    expect(($(".auto") as HTMLElement).getAttribute("aria-checked")).toBe("true");
  });

  it("collapses a section from its header", async () => {
    const n = rows("review").length;
    $("[data-section='review'] .sh")!.click();
    await settle();
    expect(rows("review")).toEqual([]);
    $("[data-section='review'] .sh")!.click();
    await settle();
    expect(rows("review").length).toBe(n);
  });
});

describe("review: files and keys", () => {
  it("editing an accepted file brings it back to review with a You chip; Space accepts it and goes to the next file", async () => {
    const f = await plain();
    const { content } = await backend.readFile("stripe", f.repo, f.path);
    await backend.writeFile("stripe", f.repo, f.path, content + "\n// by hand");
    const id = `${f.repo}/${f.path}`;
    await vi.waitFor(() => expect(rows("review")).toContain(id));
    expect($(`[data-row='${id}'] .chip.you`)).toBeTruthy();
    app.rvSelect(id);
    await settle();
    expect($(".frow.sel")?.dataset.row).toBe(id);
    const waiting = rows("review").length;
    press(" ");
    await tick();
    // at once: the file is accepted and the next file waiting is selected
    expect(rows("done")).toContain(id);
    expect(rows("review").length).toBe(waiting - 1);
    expect(app.rvs.sel).not.toBe(id);
    expect(app.selectedRow?.section).toBe("review");
    await vi.waitFor(() => expect(app.sd.status.find((c) => c.path === f.path)?.staged).toBe("modified"));
    expect(rows("done")).toContain(id);
  });

  it("Space on an accepted file takes it back to review", async () => {
    const id = rows("done")[0]!;
    app.rvSelect(id);
    await settle();
    press(" ");
    await vi.waitFor(() => expect(rows("review")).toContain(id));
    press(" ");
    await vi.waitFor(() => expect(rows("done")).toContain(id));
  });

  it("Enter focuses the diff, Tab and Shift Tab walk the hunks", async () => {
    const p = app.rows.find((r) => r.agents.length && r.hunks > 1)!;
    app.rvSelect(p.id);
    await settle();
    expect($$(".hunk").length).toBe(app.selectedHunks.length);
    expect(app.selectedHunks.length).toBeGreaterThan(1);
    expect($(".why")?.textContent).toContain("says");
    press("Enter");
    await settle();
    expect(app.rvs.focus).toBe("diff");
    expect($(".diff.focused")).toBeTruthy();
    expect(app.rvs.hunk).toBe(0);
    press("Tab");
    await settle();
    expect(app.rvs.hunk).toBe(1);
    expect($$(".hunk")[1].classList.contains("focus")).toBe(true);
    press("Tab", { shiftKey: true });
    await settle();
    expect(app.rvs.hunk).toBe(0);
  });

  it("Y accepts the hunk (accepted hunks are marked), U takes it back, N rejects a proposal", async () => {
    const before = app.pending.length;
    press("y");
    await settle();
    expect(app.pending.length).toBe(before - 1);
    app.rvLocate(app.accepted[0].hunk.id);
    await settle();
    expect($(".hunk.staged")).toBeTruthy();
    press("u");
    await settle();
    expect(app.pending.length).toBe(before);
    app.rvLocate(app.pending[0].hunk.id);
    await settle();
    press("n");
    await settle();
    expect(app.pending.length).toBe(before - 1);
    expect(app.rejected.length).toBe(1);
  });

  it("N on your own edit never discards it", async () => {
    const f = await plain();
    const { content } = await backend.readFile("stripe", f.repo, f.path);
    await backend.writeFile("stripe", f.repo, f.path, content + "\n// mine");
    const id = `${f.repo}/${f.path}`;
    await vi.waitFor(() => expect(rows("review")).toContain(id));
    app.rvSelect(id);
    await settle();
    app.rvHunkSet(app.selectedHunks.findIndex((h) => h.origin.type === "you"));
    await settle();
    const hunksBefore = app.mine.length;
    press("n");
    await settle();
    expect(app.toastState?.text).toBe("Your own changes are never discarded here");
    expect(app.mine.length).toBe(hunksBefore);
  });
});

describe("review: checks", () => {
  it("R runs every enabled check; pre-commit passes, lint fails", async () => {
    press("r");
    await vi.waitFor(() => expect(check("pre-commit").dataset.status).toBe("pass"));
    await vi.waitFor(() => expect(check("lint").dataset.status).toBe("fail"));
    expect(check("test").dataset.status).toBe("disabled");
    expect(summary()).toBe("1 of 2 passed · 1 failed · tests off");
    expect(check("pre-commit").textContent).toContain("600 ms");
    expect($(".gate")?.textContent).toBe("A check is failing");
  });

  it("clicking a row opens its log, O closes it", async () => {
    check("lint").querySelector<HTMLElement>(".main")!.click();
    await settle();
    expect($(".log")?.textContent).toContain("no-unused-vars");
    expect($(".log")?.textContent).toContain("2 problems");
    press("o");
    await settle();
    expect($(".log")).toBeNull();
    press("o");
    await settle();
    expect($(".log")).toBeTruthy();
    press("o");
    await settle();
  });

  it("Shift J picks a check, Shift R reruns it and shows it cached or fresh", async () => {
    app.focusCheck(app.checkRepos[0].checks[0]);
    press("J", { shiftKey: true });
    await settle();
    expect(app.focusedCheck?.id).toBe("lint");
    press("R", { shiftKey: true });
    await vi.waitFor(() => expect(check("lint").dataset.status).toBe("fail"));
    expect(check("lint").textContent).not.toContain("cached");
  });

  it("an optional test has a toggle; turning it on adds it to the summary", async () => {
    const toggle = check("test").querySelector<HTMLElement>(".toggle")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click();
    await vi.waitFor(() => expect(check("test").dataset.status).not.toBe("disabled"));
    app.focusCheck(app.focusedCheck ?? app.checkRepos[0].checks.find((c) => c.id === "test")!);
    app.focusCheck(app.checkRepos[0].checks.find((c) => c.id === "test")!);
    press("R", { shiftKey: true });
    await vi.waitFor(() => expect(check("test").dataset.status).toBe("pass"));
    await vi.waitFor(() => expect(summary()).toBe("2 of 3 passed · 1 failed"));
    check("test").querySelector<HTMLElement>(".toggle")!.click();
    await vi.waitFor(() => expect(check("test").dataset.status).toBe("disabled"));
    expect(summary()).toContain("tests off");
  });

  it("the Auto switch writes checks.auto", async () => {
    $(".auto")!.click();
    await vi.waitFor(() => expect($(".auto")!.getAttribute("aria-checked")).toBe("false"));
    $(".auto")!.click();
    await vi.waitFor(() => expect($(".auto")!.getAttribute("aria-checked")).toBe("true"));
  });

  it("C opens the composer, whose gate reads these results", async () => {
    // something must be staged: accept a proposal
    app.rvLocate(app.pending[0].hunk.id);
    press("y");
    await settle();
    press("c");
    await settle();
    await vi.waitFor(() => expect(app.overlay, `${app.toastState?.text} ${app.staged.length}`).toBe("commit"));
    await vi.waitFor(() => expect($$(".checks li").some((l) => l.textContent?.includes("pre-commit"))).toBe(true));
    const li = () => $$(".checks li").map((l) => (l.textContent ?? "").trim());
    await vi.waitFor(() => expect(li().some((t) => t.startsWith("Lint") && t.includes("failed")), JSON.stringify(li())).toBe(true));
    await vi.waitFor(() => expect($("#ov-in")).toBeTruthy());
    press("Escape");
    await settle();
  });

  it("with no checks the panel says how to add one", async () => {
    const id = app.space.id;
    app.data = { ...app.data, [id]: { ...app.data[id], checks: [] } };
    await settle();
    expect($(".checks .empty")?.textContent).toContain("No hooks or tests found. Add one in .vela/config.toml");
    expect(summary()).toBe("No checks");
  });
});

describe("review: narrow widths", () => {
  it("the file column width is a variable the drag handle sets (30% between 300 and 420 px by default)", () => {
    const rv = $(".rv")!;
    expect(rv.getAttribute("style")).toContain("--fw: clamp(300px, 30%, 420px)");
    app.rvWidth = 420;
    return tick().then(() => expect($(".rv")!.getAttribute("style")).toContain("--fw: 420px"));
  });
});

describe("review: approve all and comments", () => {
  it("M opens a comment box on the hunk; Enter sends it and the agent answers in the thread", async () => {
    const p = app.rows.find((r) => r.agents.length > 0)!;
    app.rvSelect(p.id);
    await settle();
    press("m");
    await settle();
    const box = $(".thread textarea") as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    box.value = "Why not a timing-safe compare?";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(app.sd.comments.length).toBe(1));
    expect(app.commentDraft).toBeNull();
    await vi.waitFor(() => expect($$(".thread .msg").map((m) => m.querySelector("b")?.textContent)).toEqual(["You", "Reviewer"]));
    expect($(".thread .msg p")?.textContent).toBe("Why not a timing-safe compare?");
  });

  it("Shift A accepts every file waiting at once, your edits and the proposals", async () => {
    const f = await plain();
    const { content } = await backend.readFile("stripe", f.repo, f.path);
    await backend.writeFile("stripe", f.repo, f.path, content + "\n// again");
    await vi.waitFor(() => expect(rows("review")).toContain(`${f.repo}/${f.path}`));
    expect(app.pending.length).toBeGreaterThan(0);
    press("A", { shiftKey: true });
    // The lists move before the backend answers.
    await tick();
    expect(rows("review")).toEqual([]);
    await vi.waitFor(() => expect(app.pending.length).toBe(0));
    await vi.waitFor(() => expect(app.sd.status.every((c) => !c.unstaged)).toBe(true));
    expect(rows("review")).toEqual([]);
    expect(rows("done").length).toBe(3);
    expect($(".head")?.textContent).toContain("All accepted");
  });
});
