// TauriBackend against a mocked `invoke`: command names, argument names, result mapping, errors.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listeners = new Map<string, (e: { payload: unknown }) => void>();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return unlisten;
  },
}));

import { BackendError, CHANGED_EVENT, TauriBackend, pinnedSpace, toBackendError } from "./backend";

beforeEach(() => {
  invoke.mockReset();
  unlisten.mockReset();
  listeners.clear();
});

describe("TauriBackend", () => {
  const b = new TauriBackend();

  it("calls the commands with camelCase argument names", async () => {
    invoke.mockResolvedValue([]);
    await b.listRepos();
    await b.listSpaces();
    await b.createSpace("Refunds", ["/w/api"]);
    await b.status("s");
    await b.hunks("s");
    await b.listFiles("s");
    await b.writeFile("s", "api", "a.ts", "x");
    expect(invoke.mock.calls).toEqual([
      ["list_repos", undefined],
      ["list_spaces", undefined],
      ["create_space", { name: "Refunds", repos: ["/w/api"] }],
      ["status", { spaceId: "s" }],
      ["hunks", { spaceId: "s" }],
      ["list_files", { spaceId: "s" }],
      ["write_file", { spaceId: "s", repo: "api", path: "a.ts", content: "x" }],
    ]);
  });

  it("stages, unstages, rejects and edits hunks", async () => {
    const hunk = { id: "h1", state: "staged" };
    invoke.mockResolvedValue(hunk);
    expect(await b.stageHunk("s", "h1")).toBe(hunk);
    await b.unstageHunk("s", "h1");
    await b.rejectHunk("s", "h1");
    await b.editHunk("s", "h1");
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["stage_hunk", "unstage_hunk", "reject_hunk", "edit_hunk"]);
    expect(invoke.mock.calls[0][1]).toEqual({ spaceId: "s", hunkId: "h1" });
  });

  it("maps a file to FileContent with its language", async () => {
    invoke.mockResolvedValue("fn main() {}\n");
    expect(await b.readFile("s", "core", "src/main.rs")).toEqual({
      repo: "core",
      path: "src/main.rs",
      content: "fn main() {}\n",
      firstLine: 1,
      language: "rust",
    });
    expect(invoke).toHaveBeenCalledWith("read_file", { spaceId: "s", repo: "core", path: "src/main.rs" });
  });

  it("commits without a push and passes the override reason", async () => {
    invoke.mockResolvedValue({ repos: ["api"], branch: "feat/x" });
    expect(await b.commit("s", "msg")).toEqual({ repos: ["api"], branch: "feat/x", pushed: false });
    expect(invoke).toHaveBeenCalledWith("commit", { spaceId: "s", message: "msg", overrideReason: null });
    await b.commit("s", "msg", "hotfix");
    expect(invoke).toHaveBeenLastCalledWith("commit", { spaceId: "s", message: "msg", overrideReason: "hotfix" });
  });

  it("opens a window for a number and closes it for null", async () => {
    invoke.mockResolvedValue(undefined);
    await b.setWindow("s", 2);
    expect(invoke).toHaveBeenLastCalledWith("open_space_window", { spaceId: "s" });
    await b.setWindow("s", null);
    expect(invoke).toHaveBeenLastCalledWith("set_window", { spaceId: "s", window: null });
  });

  it("returns empty values for the later milestones and fires the gate callback per check", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "question") return null;
      if (cmd === "reasons") return {};
      if (cmd === "run_gate") return [{ name: "tests", detail: "ok", pass: true }];
      return [];
    });
    expect(await b.agents("s")).toEqual([]);
    expect(await b.notes("s")).toEqual([]);
    expect(await b.stack("s")).toEqual([]);
    expect(await b.question("s")).toBeNull();
    expect(await b.reasons("s")).toEqual({});
    const seen: number[] = [];
    const checks = await b.runGate("s", (i) => seen.push(i));
    expect(checks).toHaveLength(1);
    expect(seen).toEqual([0]);
  });

  it("turns { kind, message } rejections into Errors", async () => {
    invoke.mockRejectedValue({ kind: "forbidden_path", message: "path is outside the space worktree: ../x" });
    const err = await b.readFile("s", "api", "../x").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BackendError);
    expect(err.kind).toBe("forbidden_path");
    expect(err.message).toContain("outside the space worktree");
    invoke.mockRejectedValue("boom");
    expect((await b.status("s").catch((e) => e)).message).toBe("boom");
    expect(toBackendError(new Error("x")).message).toBe("x");
  });

  it("forwards vela://changed events and unsubscribes", async () => {
    const got: unknown[] = [];
    const off = b.onChange((e) => got.push(e));
    await Promise.resolve();
    await Promise.resolve();
    expect(CHANGED_EVENT).toBe("vela://changed");
    listeners.get(CHANGED_EVENT)!({ payload: { spaceId: "s", kind: "file" } });
    expect(got).toEqual([{ spaceId: "s", kind: "file" }]);
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("pinnedSpace", () => {
  it("reads the space id from the hash", () => {
    expect(pinnedSpace("#space-fix-it")).toBe("fix-it");
    expect(pinnedSpace("")).toBeNull();
    expect(pinnedSpace("#other")).toBeNull();
  });
});
