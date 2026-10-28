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
  // CodeMirror measures text; jsdom has no layout.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
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

  it("the diff shows the whole file with the agent's changes merged in; Tab walks the changes", async () => {
    const p = app.rows.find((r) => r.agents.length && r.hunks > 1)!;
    app.rvSelect(p.id);
    await settle();
    await vi.waitFor(() => expect($("section[aria-label='Diff'] .cm-editor")).toBeTruthy());
    const fr = await backend.reviewFile(app.space.id, p.repo, p.path);
    // What accepting writes is what the editor holds.
    expect(app.pane?.doc()).toBe(fr.result);
    const added = app.selectedHunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.text));
    for (const t of added) expect(app.pane?.doc()).toContain(t);
    expect($(".why")?.textContent).toBeTruthy();
    press("Enter");
    await settle();
    expect(app.rvs.focus).toBe("diff");
    const l0 = app.pane!.line();
    press("Tab");
    await settle();
    const l1 = app.pane!.line();
    expect(l1).not.toBe(l0);
    // Shift Tab goes back (wrapping to the last change when on the first).
    press("Tab", { shiftKey: true });
    await settle();
    press("Tab");
    await settle();
    expect(app.pane!.line()).toBe(l1);
  });

  it("what you change in the diff is what gets accepted", async () => {
    const p = app.rows.find((r) => r.section === "review" && r.agents.length)!;
    app.rvSelect(p.id);
    await settle();
    await vi.waitFor(() => expect(app.pane).toBeTruthy());
    const text = app.pane!.doc() + "\n// tweaked in review";
    app.pane!.setDoc(text);
    await settle();
    expect($(`[data-row='${p.id}'] .chip.ed`)).toBeTruthy();
    expect($(".banner.info")?.textContent).toContain("Edited by you");
    press(" ");
    await vi.waitFor(() => expect(rows("done")).toContain(p.id));
    expect((await backend.readFile(app.space.id, p.repo, p.path)).content).toBe(text);
  });

  it("a conflict blocks accepting until each block has a side", async () => {
    const p = app.rows.find((r) => r.section === "review" && r.agents.length)!;
    app.rvSelect(p.id);
    await settle();
    await vi.waitFor(() => expect(app.pane).toBeTruthy());
    const doc = app.pane!.doc();
    app.pane!.setDoc(`<<<<<<< yours\nmine\n=======\ntheirs\n>>>>>>> agent\n${doc}`);
    await settle();
    expect($(".banner.warn")?.textContent).toContain("1 conflict with your edits");
    expect($(`[data-row='${p.id}'] .chip.cf`)).toBeTruthy();
    const accept = $$(".dh .btn.p")[0] as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    press(" ");
    await settle();
    expect(app.toastState?.text).toContain("conflict");
    expect(rows("review")).toContain(p.id);
    $$(".banner.warn .btn").find((b) => b.textContent === "Take all the agent's")!.click();
    await settle();
    expect(app.pane!.doc()).toBe(`theirs\n${doc}`);
    expect($(".banner.warn")).toBeNull();
    press(" ");
    await vi.waitFor(() => expect(rows("done")).toContain(p.id));
  });

  it("U takes an accepted file back to review, N rejects the agent's changes of a file", async () => {
    const id = rows("done").find((r) => app.rows.find((x) => x.id === r)?.hunks)!;
    app.rvSelect(id);
    await settle();
    press("u");
    await vi.waitFor(() => expect(rows("review")).toContain(id));
    const p = app.rows.find((r) => r.section === "review" && r.agents.length)!;
    app.rvSelect(p.id);
    await settle();
    const before = app.pending.length;
    press("n");
    await vi.waitFor(() => expect(app.pending.length).toBeLessThan(before));
    expect(app.rejected.length).toBeGreaterThan(0);
  });

  it("N on your own edit never discards it", async () => {
    const f = await plain();
    const { content } = await backend.readFile("stripe", f.repo, f.path);
    await backend.writeFile("stripe", f.repo, f.path, content + "\n// mine");
    const id = `${f.repo}/${f.path}`;
    await vi.waitFor(() => expect(rows("review")).toContain(id));
    app.rvSelect(id);
    await settle();
    const hunksBefore = app.mine.length;
    press("n");
    await settle();
    expect(app.toastState?.text).toContain("Your own edits are never thrown away");
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
    // files were accepted above: something is staged
    expect(app.staged.length).toBeGreaterThan(0);
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
  it("M opens a comment box on the line of the diff; Enter sends it and the agent answers in the thread", async () => {
    const p = app.rows.find((r) => r.section === "review") ?? app.rows[0];
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
    press("A", { shiftKey: true });
    // The lists move before the backend answers.
    await tick();
    expect(rows("review")).toEqual([]);
    await vi.waitFor(() => expect(app.pending.length).toBe(0));
    await vi.waitFor(() => expect(app.sd.status.every((c) => !c.unstaged)).toBe(true));
    expect(rows("review")).toEqual([]);
    expect(rows("done").length).toBeGreaterThan(0);
    expect($(".head")?.textContent).toContain("All accepted");
  });
});
