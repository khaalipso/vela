// @vitest-environment jsdom
// A real link anywhere in the app opens in the default browser; a conversation can be deleted.
import { mount, tick, unmount } from "svelte";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import App from "./App.svelte";
import { app } from "./lib/app.svelte";
import { MockBackend } from "./lib/backend";

const backend = new MockBackend({ speed: 0 });
let component: ReturnType<typeof mount>;

beforeAll(async () => {
  Element.prototype.scrollIntoView = () => {};
  await app.init(backend);
  component = mount(App, { target: document.body });
  await tick();
});
afterAll(() => {
  void unmount(component);
  app.destroy();
});

describe("links", () => {
  it("an http link opens in the browser and the app does not navigate", async () => {
    const a = document.createElement("a");
    a.href = "https://example.com/x";
    document.body.append(a);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(backend.opened).toContain("https://example.com/x");
    a.remove();
  });
  it("other links are left alone", () => {
    const a = document.createElement("a");
    a.setAttribute("href", "#top");
    document.body.append(a);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    a.remove();
  });
});

describe("delete an agent", () => {
  it("removes a finished one and refuses one at work", async () => {
    const id = app.space.id;
    const list = await backend.agents(id);
    const done = list.find((a) => a.status !== "working" && a.status !== "waiting");
    if (done) {
      await backend.deleteAgent(id, done.id);
      expect((await backend.agents(id)).some((a) => a.id === done.id)).toBe(false);
    }
    const busy = (await backend.agents(id)).find((a) => a.status === "working" || a.status === "waiting");
    if (busy) await expect(backend.deleteAgent(id, busy.id)).rejects.toThrow(/still running/);
  });
});
