// @vitest-environment jsdom
// Headless smoke test of the whole shell: Svelte components, the store, the mock backend
// and CodeMirror, driven by synthetic key events. No screen involved.
import { EditorView } from "@codemirror/view";
import { mount, tick, unmount } from "svelte";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";
import { app } from "./lib/app.svelte";
import { MockBackend } from "./lib/backend";

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
  // jsdom has no layout; CodeMirror measures with these.
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => {};
  await app.init(new MockBackend({ speed: 0 }));
  component = mount(App, { target: document.body });
  await settle();
});
afterAll(() => {
  void unmount(component);
  app.destroy();
});

describe("shell", () => {
  it("opens on the first space in review with the island on the proposals", () => {
    expect($("h1")?.textContent).toContain("Stripe v2 billing");
    expect($$(".sp").length).toBe(3);
    expect($(".island b")?.textContent).toBe("Review 3 proposals");
    // three zones: files with the proposals listed, the diff of the first one, the checks
    expect($$("[data-section='proposed'] .frow").length).toBe(2);
    expect($$(".hunk").length).toBe(2);
    expect($$(".hunk.focus").length).toBe(1);
    expect($(".hunk.focus")?.textContent).toContain("Verify the Stripe signature");
    expect($("aside[aria-label='Checks']")).toBeTruthy();
    expect(document.documentElement.style.getPropertyValue("--space")).toBe("#E8A14A");
  });

  it("Tab moves the hunk cursor, Y accepts, U undoes", async () => {
    press("Tab");
    await settle();
    expect($(".hunk.focus")?.textContent).toContain("Log event ids");
    press("y");
    await settle();
    expect($$(".hunk[data-state='staged']").length).toBe(1);
    expect($(".island b")?.textContent).toBe("Review 2 proposals");
    // after accepting, the cursor moved on to the next pending proposal
    expect($(".hunk.focus")?.textContent).toContain("Verify the Stripe signature");
    press("Tab");
    await settle();
    expect($(".hunk.focus")?.textContent).toContain("Log event ids");
    press("u");
    await settle();
    expect($$(".hunk[data-state='staged']").length).toBe(0);
    expect($(".island b")?.textContent).toBe("Review 3 proposals");
  });

  it("switching space changes the accent, Alt 2 jumps, [ goes back", async () => {
    press("2", { altKey: true });
    await settle();
    expect($("h1")?.textContent).toContain("Postgres 17");
    expect(document.documentElement.style.getPropertyValue("--space")).toBe("#7DB8F5");
    // pg opens in the agents view with its question
    expect($(".ask p")?.textContent).toContain("pg_trgm");
    expect($(".island b")?.textContent).toBe("Crush is waiting for you");
    press("[");
    await settle();
    expect($("h1")?.textContent).toContain("Stripe v2 billing");
  });

  it("Ctrl K opens the command bar, typing filters, Esc closes", async () => {
    press("k", { ctrlKey: true });
    await settle();
    const input = $("#pal-in") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = "compose";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect($$(".pit").length).toBe(1);
    expect($(".pit")?.textContent).toContain("compose.yml");
    press("Escape", {}, input);
    await settle();
    expect($("#pal-in")).toBeNull();
  });

  it("the code view mounts an editor with the proposal as a widget and no leftover line", async () => {
    press("1");
    await settle();
    await vi.waitFor(() => expect($(".cm-editor")).toBeTruthy());
    await vi.waitFor(() => expect($$(".cm-hunk").length).toBe(2));
    // webhook.ts has 13 lines; s1 replaces 1 line with a widget, s3 is an insert
    expect($$(".cm-line").length).toBe(12);
    // the first gutter element is the hidden width spacer; line numbers start at the real line 12
    const ln = $$(".cm-lineNumbers .cm-gutterElement").map((e) => e.textContent);
    expect(ln).toContain("12");
    expect(ln).not.toContain("1");
  });

  it("single letters are ignored while typing in the editor, Esc leaves it", async () => {
    const view = EditorView.findFromDOM($(".cm-editor")!)!;
    view.focus();
    const content = $(".cm-content")!;
    expect(document.activeElement).toBe(content);
    const before = app.pending.length;
    press("y", {}, content);
    press("n", {}, content);
    await settle();
    expect(app.pending.length).toBe(before);
    press("Escape", {}, content);
    expect(document.activeElement).not.toBe(content);
  });

  it("what you type is sent to the backend and marked in the gutter and the drawer", async () => {
    const view = EditorView.findFromDOM($(".cm-editor")!)!;
    const end = view.state.doc.line(view.state.doc.lines).to;
    view.dispatch({ changes: { from: end, insert: "\n// by hand" }, userEvent: "input.type" });
    await settle();
    await vi.waitFor(() => expect(app.mine.length).toBe(1));
    expect($$(".cm-mine-gutter .cm-gutterElement").some((e) => e.textContent === "•")).toBe(true);
    press("b");
    await settle();
    await vi.waitFor(() => expect($$(".files .row").length).toBeGreaterThan(0));
    $$(".files .chip").find((c) => c.textContent === "Changed")!.click();
    await settle();
    const names = $$(".files .row.file").map((r) => r.textContent);
    expect(names.some((n) => n?.includes("webhook.ts") && n.includes("M"))).toBe(true);
    press("b");
  });

  it("Y in the code view accepts the focused widget and the editor shows the new lines", async () => {
    app.cui.hi = "s1";
    await vi.waitFor(() => expect(app.focused?.hunk.state).toBe("pending"));
    const id = app.focused!.hunk.id;
    press("y");
    await vi.waitFor(() => expect(app.proposals.find((p) => p.hunk.id === id)?.hunk.state).toBe("staged"));
    await settle();
    const doc = EditorView.findFromDOM($(".cm-editor")!)!.state.doc.toString();
    expect(doc).toContain("stripe.webhooks.constructEvent");
    expect(doc).toContain("// by hand");
  });

  it("the commit gate opens on C and reads the real checks plus the backend gate", async () => {
    press("c");
    await settle();
    // pre-commit and lint from the checks, then the five rows of the backend gate
    await vi.waitFor(() => expect($$(".checks li").length).toBe(7));
    await vi.waitFor(() =>
      expect($$(".checks li em").every((e) => e.textContent !== "running" && e.textContent !== "not run")).toBe(true),
    );
    const rows = $$(".checks li").map((e) => (e.textContent ?? "").trim());
    expect(rows.some((t) => t.includes("pre-commit") && t.includes("passed")), JSON.stringify(rows)).toBe(true);
    expect(rows.some((t) => t.startsWith("Lint") && !t.startsWith("Lint and") && t.includes("failed")), JSON.stringify(rows)).toBe(true);
    // the stripe space fails its gate: override needed
    expect($("#ov-in")).toBeTruthy();
    expect(($(".btn.p[disabled]") as HTMLButtonElement | null)).toBeTruthy();
    press("Escape");
    await settle();
    expect($(".checks")).toBeNull();
  });

  it("W moves the space to window 2 and shows the placeholder", async () => {
    press("w");
    await settle();
    expect($(".elsewhere h3")?.textContent).toContain("is open in window 2");
    expect($(".island b")?.textContent).toBe("This space is open in window 2");
    press("Enter");
    await settle();
    expect($(".elsewhere")).toBeNull();
  });

  it("F asks the author to fix the reviewer note and a follow-up proposal appears", async () => {
    press("2");
    await settle();
    app.cui.hi = "s1";
    await settle();
    press("f");
    await vi.waitFor(() => expect(app.proposals.some((p) => p.hunk.id === "s1f")).toBe(true));
    expect(app.proposals.find((p) => p.hunk.id === "s1f")?.hunk.state).toBe("pending");
    expect(app.sd.notes[0].resolved).toBe(true);
  });

  it("E accepts, opens the code view and puts the cursor in the editor", async () => {
    app.cui.hi = "s1f";
    await settle();
    press("e");
    await vi.waitFor(() => expect(app.view).toBe("code"));
    await vi.waitFor(() => expect(document.activeElement?.classList.contains("cm-content")).toBe(true));
    expect(EditorView.findFromDOM($(".cm-editor")!)!.state.doc.toString()).toContain('status: 400');
    expect(app.toastState?.text).toBe("Accepted. Edit the lines, then Esc");
    press("Escape", {}, document.activeElement!);
  });

  it("New space: name, repos, Ctrl Enter creates it and opens the agents view", async () => {
    $(".newsp")!.click();
    await settle();
    const name = $("#ns-name") as HTMLInputElement;
    name.value = "Refunds in checkout";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    $$(".rtog").find((b) => b.textContent === "web")!.click();
    await settle();
    press("Enter", { ctrlKey: true }, name);
    await vi.waitFor(() => expect(app.spaces.length).toBe(4));
    await settle();
    expect($("h1")?.textContent).toContain("Refunds in checkout");
    expect($$(".agent").length).toBe(1);
    expect($$(".chip").length).toBe(2);
    expect(document.documentElement.style.getPropertyValue("--space")).toBe("#4ADE80");
  });
});
