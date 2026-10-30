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

describe("browse for a folder", () => {
  it("selects the picked folder and stays on the current branch", async () => {
    const be = new MockBackend();
    await app.init(be);
    app.newSp = { name: "", repos: [], missingName: false, branch: "", base: "", repoBranches: {}, ticket: "" };
    await app.browseRepos();
    expect(app.overlay).toBe("newspace");
    expect(app.repos[0]).toBe("~/Work/fresh-folder");
    expect(app.newSp.repos).toEqual(["~/Work/fresh-folder"]);
    expect(app.newSp.branch).toBe("");
  });

  it("does nothing when the dialog is cancelled", async () => {
    const be = new MockBackend();
    be.pickedFolder = null;
    await app.init(be);
    app.newSp = { name: "", repos: [], missingName: false, branch: "", base: "", repoBranches: {}, ticket: "" };
    await app.browseRepos();
    expect(app.newSp.repos).toEqual([]);
  });
});

describe("repos of a space", () => {
  it("adds a repo to the current space, then removes it", async () => {
    await app.init(new MockBackend());
    const before = app.space.repos.length;
    app.openAddRepo();
    expect(app.sheetMode).toBe("add");
    app.newSp.repos = ["~/code/payments"];
    await app.addRepos();
    expect(app.space.repos.map((r) => r.name)).toContain("payments");
    expect(app.space.repos.length).toBe(before + 1);
    expect(app.overlay).toBeNull();
    await app.removeRepo("payments");
    expect(app.space.repos.length).toBe(before);
  });
});
