// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { app } from "./lib/app.svelte";
import { MockBackend } from "./lib/backend";

describe("repo picker", () => {
  it("filters repos, keeps selected first, declares a path", async () => {
    await app.init(new MockBackend());
    app.newSp.repos = [];
    app.repoFilter = "inf";
    expect(app.shownRepos.every((r) => r.includes("inf"))).toBe(true);
    await app.repoFilterEnter();
    expect(app.newSp.repos).toEqual(["infra"]);
    expect(app.repoFilter).toBe("");
    expect(app.shownRepos[0]).toBe("infra");

    app.repoFilter = "~/code/shop";
    expect(app.shownRepos.length).toBe(app.repos.length);
    await app.repoFilterEnter();
    expect(app.repos[0]).toBe("~/code/shop");
    expect(app.newSp.repos).toContain("~/code/shop");
  });
});
