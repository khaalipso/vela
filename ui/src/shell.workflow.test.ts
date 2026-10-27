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
    const proposed = app.rows.find((r) => r.section === "proposed")!;
    app.rvSelect(proposed.id);
    await settle();
    expect($(".split")).toBeNull();
    press("v");
    await settle();
    expect($$(".split").length).toBeGreaterThan(0);
    expect($(".split .hd")?.textContent).toContain("Before");
    expect(app.view).toBe("review");
    press("v");
    await settle();
    expect($(".split")).toBeNull();
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
