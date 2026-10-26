// @vitest-environment jsdom
// The file tree drawer and quick open in the whole shell, on the mock backend.
import { mount, tick, unmount } from "svelte";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";
import { app } from "./lib/app.svelte";
import { MockBackend } from "./lib/backend";
import { files } from "./lib/files.svelte";

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const press = (key: string, o: KeyboardEventInit = {}, target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...o }));
const settle = async () => {
  await tick();
  await new Promise((r) => setTimeout(r, 10));
  await tick();
};
const type = async (input: HTMLInputElement, text: string) => {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};

let component: ReturnType<typeof mount>;

beforeAll(async () => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => {};
  await app.init(new MockBackend({ speed: 0 }));
  app.filesOpen = false;
  component = mount(App, { target: document.body });
  await settle();
});
afterAll(() => {
  void unmount(component);
  app.destroy();
  files.stop();
});

describe("files drawer", () => {
  it("B opens it with the repos as top nodes and the open file revealed", async () => {
    press("1");
    await settle();
    press("b");
    await settle();
    await vi.waitFor(() => expect($$(".files .row.repo").length).toBeGreaterThan(0));
    expect($(".files .row.open")?.textContent).toContain("webhook.ts");
    // Shift H collapses everything: the three repos of the space are the top nodes
    press("H", { shiftKey: true }, $(".files .tree")!);
    await settle();
    expect($$(".files .row.repo").length).toBe(3);
    expect($$(".files .row.repo").map((r) => r.textContent)).toEqual([
      expect.stringContaining("api"),
      expect.stringContaining("web"),
      expect.stringContaining("infra"),
    ]);
    // "." reveals the open file again and folders holding changes show a count
    press(".", {}, $(".files .tree")!);
    await settle();
    expect($(".files .row.open")?.textContent).toContain("webhook.ts");
    expect($$(".files .row.dir .dm").length).toBeGreaterThan(0);
  });

  it("only renders a window of rows even with hundreds of files", async () => {
    press("Enter", {}, $(".files .tree")!);
    expect($$(".files .row").length).toBeLessThan(80);
  });

  it("/ jumps into the filter, typing filters, Enter opens the top result in the editor", async () => {
    $(".files .tree")!.focus();
    press("/", {}, $(".files .tree")!);
    await settle();
    const input = $("[data-files-filter]") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await type(input, "src/billing/checkout");
    expect($(".files .count")?.textContent).toMatch(/\d+ match/);
    expect($$(".files .row.file .hit").length).toBeGreaterThan(0);
    expect($$(".files .row.cur")[0]?.textContent).toContain("checkout.ts");
    press("Enter", {}, input);
    await settle();
    expect(app.cui.file).toBe("api/src/billing/checkout.ts");
    expect(app.cui.tabs.find((t) => t.key === "api/src/billing/checkout.ts")?.pinned).toBe(false);
  });

  it("Esc clears the filter, then leaves", async () => {
    const input = $("[data-files-filter]") as HTMLInputElement;
    input.focus();
    press("Escape", {}, input);
    await settle();
    expect(files.query).toBe("");
    expect(document.activeElement).toBe(input);
    press("Escape", {}, input);
    await settle();
    expect(document.activeElement).toBe($(".files .tree"));
  });

  it("chips filter on status, Alt S shows the staged files only", async () => {
    press("s", { altKey: true }, $(".files .tree")!);
    await settle();
    expect(files.chip).toBe("staged");
    const names = $$(".files .row.file").map((r) => r.textContent ?? "");
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => /[A-Z]\s*$/.test(n))).toBe(true);
    press("a", { altKey: true }, $(".files .tree")!);
    await settle();
    expect(files.chip).toBe("all");
  });

  it("typing a letter in the tree starts the filter", async () => {
    const tree = $(".files .tree")!;
    tree.focus();
    press("w", {}, tree);
    await settle();
    expect(files.query).toBe("w");
    expect(document.activeElement).toBe($("[data-files-filter]"));
    files.clearFilter();
    await settle();
  });

  it("Space unstages a staged file, then stages it again", async () => {
    const tree = $(".files .tree")!;
    tree.focus();
    files.chip = "changed";
    await settle();
    const row = $$(".files .row.file").find((r) => r.querySelector(".st.staged"))!;
    expect(row).toBeTruthy();
    const name = row.textContent!.trim().split(/\s/)[0];
    row.click();
    await settle();
    files.chip = "all";
    await settle();
    press(" ", {}, tree);
    const find = () => $$(".files .row.file").find((r) => r.textContent?.includes(name));
    // The mock drops a change staged before the session once unstaged (real git keeps it unstaged).
    await vi.waitFor(() => expect(find()?.querySelector(".st.staged")).toBeFalsy());
    press(" ", {}, tree);
    await vi.waitFor(() => expect(find()?.querySelector(".st.staged")).toBeTruthy());
  });

  it("Ctrl P opens quick open, which finds a file across repos and opens it", async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    press("p", { ctrlKey: true });
    await settle();
    const input = $("#qo-in") as HTMLInputElement;
    expect(input).toBeTruthy();
    await type(input, "lib/stripe");
    const first = $$(".pit")[0];
    expect(first.textContent).toContain("web");
    expect(first.textContent).toContain("stripe.ts");
    press("Enter", {}, input);
    await settle();
    expect(app.overlay).toBeNull();
    expect(app.cui.file).toBe("web/lib/stripe.ts");
  });

  it("B closes the drawer again", async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    press("b");
    await settle();
    expect($(".files")).toBeNull();
  });
});
