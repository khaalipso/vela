// @vitest-environment jsdom
// Links and the commit composer through the whole shell on the mock backend, driven by synthetic
// key events and paste events. No screen involved.
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
const paste = (text: string, target: EventTarget = document.body) => {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: { getData: () => text } });
  target.dispatchEvent(e);
  return e;
};
const typeInto = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};

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

describe("links", () => {
  it("the top bar shows the issue key first, then the other links", () => {
    expect($$(".lk .lt").map((e) => e.textContent)).toEqual([
      "PAY-412",
      "Stripe webhooks",
      "Payments latency",
      "Staging acme.dev",
    ]);
    expect($(".lk.more")).toBeNull();
  });

  it("L opens the sheet grouped by kind; Esc leaves the field, J K move, Enter opens", async () => {
    press("l");
    await settle();
    expect(app.overlay).toBe("links");
    expect($$(".sheet .psec").map((e) => e.textContent)).toEqual(["Issues", "Docs", "Dashboards", "Environments"]);
    expect(document.activeElement?.id).toBe("links-in");
    press("Escape", {}, document.activeElement!);
    (document.activeElement as HTMLElement).blur();
    await settle();
    expect(app.overlay).toBe("links");
    expect($(".pit[aria-selected='true']")?.textContent).toContain("PAY-412");
    press("j");
    await settle();
    expect($(".pit[aria-selected='true']")?.textContent).toContain("Stripe webhooks");
    press("Enter");
    await settle();
    expect(backend.opened).toEqual(["https://docs.stripe.com/webhooks"]);
  });

  it("Backspace removes only what you added", async () => {
    press("k");
    await settle();
    press("Backspace");
    await settle();
    expect(app.toastState?.text).toBe("Found in the history, it cannot be removed here");
    expect(app.links.length).toBe(4);
    press("j");
    press("j");
    await settle();
    expect($(".pit[aria-selected='true']")?.textContent).toContain("Payments latency");
    press("Backspace");
    await settle();
    expect(app.toastState?.text).toBe("Repo links live in .vela/links.toml");
    // Staging was typed by hand: it goes.
    press("j");
    await settle();
    expect($(".pit[aria-selected='true']")?.textContent).toContain("Staging");
    press("Backspace");
    await settle();
    expect(app.toastState?.text).toBe("Removed Staging acme.dev");
    expect(app.links.map((l) => l.title)).not.toContain("Staging acme.dev");
  });

  it("typing a URL previews it live and Enter adds it", async () => {
    const field = $("#links-in") as HTMLInputElement;
    field.focus();
    await typeInto(field, "https://acme.atlassian.net/browse/PAY-9");
    expect($(".preview")?.textContent).toContain("PAY-9");
    expect($(".preview")?.textContent).toContain("issue");
    await typeInto(field, "linear dot app");
    expect($(".preview")?.textContent).toContain("Not a full http or https URL");
    press("Enter", {}, field);
    await settle();
    expect(app.toastState?.text).toBe("Paste a full http or https URL");
    await typeInto(field, "https://acme.atlassian.net/browse/PAY-9");
    press("Enter", {}, field);
    await settle();
    expect(app.toastState?.text).toBe("Linked PAY-9");
    expect(field.value).toBe("");
    // Issues come first in the sheet and in the top bar, and the new row is selected.
    expect($(".pit[aria-selected='true']")?.textContent).toContain("PAY-9");
    press("Escape", {}, field);
    field.blur();
    press("Escape");
    await settle();
    expect(app.overlay).toBeNull();
    expect($$(".lk .lt").map((e) => e.textContent).slice(0, 2)).toEqual(["PAY-412", "PAY-9"]);
  });

  it("the command bar opens a link by its key", async () => {
    press("t", { ctrlKey: true });
    await settle();
    await typeInto($("#pal-in") as HTMLInputElement, "pay-412");
    expect($$(".pit").map((e) => e.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Open PAY-412")]));
    press("Enter", {}, $("#pal-in")!);
    await settle();
    expect(backend.opened.at(-1)).toBe("https://acme.atlassian.net/browse/PAY-412");
    expect(app.overlay).toBeNull();
  });

  it("pasting a URL outside any field links it; +N counts the links the bar cannot show", async () => {
    expect(paste("not a url").defaultPrevented).toBe(false);
    expect(paste("https://www.figma.com/design/AbC/Checkout-flow").defaultPrevented).toBe(true);
    await settle();
    expect(app.toastState?.text).toBe("Linked Checkout flow");
    expect((await backend.links("stripe")).at(-1)).toMatchObject({ source: "paste", kind: "design", provider: "figma" });
    expect($$(".lk .lt").length).toBe(5);
    await app.dispatch({ type: "open-link", id: app.links.at(-1)!.id });
    expect(backend.opened.at(-1)).toBe("https://www.figma.com/design/AbC/Checkout-flow");
  });
});

describe("commit composer", () => {
  it("accepting a file stages it; C plans the commits of one repo with the ticket footer", async () => {
    // Y accepts the file to review (both proposals of webhook.ts), then the next one.
    press("y");
    await settle();
    press("y");
    await settle();
    expect(app.staged.map((f) => f.path).sort()).toEqual(["lib/stripe.ts", "src/billing/checkout.ts", "src/billing/webhook.ts"]);
    press("c");
    await settle();
    // two rows from the checks of the Review view (pre-commit, lint), five from the backend gate
    await vi.waitFor(() => expect($$(".checks li em").length).toBe(7));
    await vi.waitFor(() =>
      expect($$(".checks li em").every((e) => e.textContent !== "running" && e.textContent !== "not run")).toBe(true),
    );
    // One repo per commit: api first, web has its own tab.
    expect(app.cc!.repo).toBe("api");
    expect($$(".rtab").map((e) => e.querySelector("b")?.textContent)).toEqual(["api", "web"]);
    expect($$(".card").length).toBe(1);
    expect($$(".card .prev").map((e) => e.textContent)).toEqual(["fix(billing): update webhook and checkout"]);
    expect(($('[data-field="footers"]') as HTMLTextAreaElement).value).toBe("Refs: PAY-412, PAY-9");
    expect($$(".card.focus .hk .p").map((e) => e.textContent)).toEqual(["src/billing/webhook.ts", "src/billing/webhook.ts", "src/billing/checkout.ts"]);
    expect($$(".card.focus .hk .n").map((e) => e.textContent)).toEqual(["staged earlier"]);
  });

  it("T cycles the type, ! marks a breaking change, hunks stay in their repo", async () => {
    press("t");
    await settle();
    expect($(".card.focus .prev")?.textContent).toBe("refactor(billing): update webhook and checkout");
    // Nine more presses go round the eleven types to feat.
    for (let i = 0; i < 9; i++) press("t");
    await settle();
    expect(app.cc!.groups[0].kind).toBe("feat");
    press("!");
    await settle();
    expect($(".card.focus .prev")?.textContent).toBe("feat(billing)!: update webhook and checkout");
    const reason = $('.card.focus [data-field="reason"]') as HTMLInputElement;
    await typeInto(reason, "handleWebhook now needs a signature");
    // The commits of web are not in this composer.
    press("2", {});
    await settle();
    expect(app.toastState?.text).toBe("There is no commit 2");
    expect(app.cc!.groups.map((g) => g.hunks.length)).toEqual([3]);
    press("m");
    expect(app.toastState?.text).toBe("Already one commit");
    // R goes to the next repo and back; what you edited stays.
    press("r");
    await settle();
    expect(app.cc!.repo).toBe("web");
    expect($$(".card .prev").map((e) => e.textContent)).toEqual(["fix(lib): update stripe"]);
    press("r");
    await settle();
    expect(app.cc!.repo).toBe("api");
    expect($(".card.focus .prev")?.textContent).toBe("feat(billing)!: update webhook and checkout");
  });

  it("a long subject shows the problem inline and blocks the commit", async () => {
    const subject = $('.card.focus [data-field="subject"]') as HTMLInputElement;
    const old = subject.value;
    await typeInto(subject, "x".repeat(80));
    await vi.waitFor(() => expect(app.cc!.problems[app.cc!.groups[0].id]?.length).toBe(1));
    await settle();
    expect($(".card.focus .probs")?.textContent).toContain("limit is 72");
    expect(($$(".sheet .btn.p")[0] as HTMLButtonElement).disabled).toBe(true);
    await typeInto(subject, old);
    await vi.waitFor(() => expect(app.cc!.problems[app.cc!.groups[0].id]?.length).toBe(0));
    await settle();
    expect($(".card.focus .probs")).toBeNull();
  });

  it("Ctrl Enter in the override field commits the repo, the other one waits", async () => {
    // The stripe gate fails (an open reviewer note): a reason is needed.
    expect(($$(".sheet .btn.p")[0] as HTMLButtonElement).disabled).toBe(true);
    const ov = $("#ov-in") as HTMLInputElement;
    await typeInto(ov, "Hotfix, tests are flaky on CI");
    expect(($$(".sheet .btn.p")[0] as HTMLButtonElement).disabled).toBe(false);
    press("Enter", { ctrlKey: true }, ov);
    await settle();
    await vi.waitFor(() => expect(backend.commits.length).toBe(1));
    expect(backend.commits.map((c) => [c.repos, c.group])).toEqual([[["api"], "g1"]]);
    expect(backend.commits[0].message).toBe(
      "feat(billing)!: update webhook and checkout\n\nBREAKING CHANGE: handleWebhook now needs a signature\nRefs: PAY-412, PAY-9\nVela-Override: Hotfix, tests are flaky on CI",
    );
    expect(app.toastState?.text).toBe("Pushed 1 commit in api on feat/stripe-v2. web has staged changes too: C to commit");
    expect(app.overlay).toBeNull();
    expect(app.staged.map((f) => f.path)).toEqual(["lib/stripe.ts"]);
  });
});
