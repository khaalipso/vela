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

describe("new repo", () => {
  it("creates a repo, selects it and names the space after it", async () => {
    await app.init(new MockBackend());
    app.newSp = { name: "", repos: [], missingName: false, branch: "", base: "" };
    await app.openNewRepo();
    expect(app.overlay).toBe("newspace");
    expect(app.newRepo.parent).toBe("~/Work");
    app.newRepo.name = "billing-svc";
    await app.createRepo();
    expect(app.repos[0]).toBe("~/Work/billing-svc");
    expect(app.newSp.repos).toEqual(["~/Work/billing-svc"]);
    expect(app.newSp.name).toBe("billing-svc");
    expect(app.newRepo.open).toBe(false);
  });

  it("refuses an empty name", async () => {
    await app.openNewRepo();
    app.newRepo.name = " ";
    await app.createRepo();
    expect(app.newRepo.open).toBe(true);
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
