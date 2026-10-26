// TauriBackend: command names and argument names of the menu operations.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { BackendError, TauriBackend } from "./backend";

beforeEach(() => invoke.mockReset());

describe("TauriBackend menu operations", () => {
  const b = new TauriBackend();

  it("calls the file commands with camelCase arguments", async () => {
    invoke.mockResolvedValue(undefined);
    await b.createFile("s", "api", "a.ts");
    await b.createDir("s", "api", "src/new");
    await b.renamePath("s", "api", "a.ts", "b.ts");
    await b.discardFile("s", "api", "a.ts");
    await b.revealPath("s", "api", "");
    await b.openTerminal("s", "api", "src");
    expect(invoke.mock.calls).toEqual([
      ["create_file", { spaceId: "s", repo: "api", path: "a.ts" }],
      ["create_dir", { spaceId: "s", repo: "api", path: "src/new" }],
      ["rename_path", { spaceId: "s", repo: "api", from: "a.ts", to: "b.ts" }],
      ["discard_file", { spaceId: "s", repo: "api", path: "a.ts" }],
      ["reveal_path", { spaceId: "s", repo: "api", path: "" }],
      ["open_terminal", { spaceId: "s", repo: "api", path: "src" }],
    ]);
  });

  it("delete reports trashed or deleted, and a missing trash comes back as a typed error", async () => {
    invoke.mockResolvedValueOnce("trashed");
    expect(await b.deletePath("s", "api", "a.ts")).toBe("trashed");
    expect(invoke).toHaveBeenLastCalledWith("delete_path", { spaceId: "s", repo: "api", path: "a.ts", permanent: false });
    invoke.mockResolvedValueOnce("deleted");
    expect(await b.deletePath("s", "api", "a.ts", true)).toBe("deleted");
    expect(invoke).toHaveBeenLastCalledWith("delete_path", { spaceId: "s", repo: "api", path: "a.ts", permanent: true });
    invoke.mockRejectedValueOnce({ kind: "no_trash", message: "no system trash" });
    const err = await b.deletePath("s", "api", "a.ts").catch((e) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err.kind).toBe("no_trash");
  });

  it("calls the space commands", async () => {
    invoke.mockResolvedValue({});
    await b.renameSpace("s", "New");
    await b.setSpaceColor("s", "#7DB8F5");
    await b.archiveSpace("s");
    await b.unarchiveSpace("s");
    await b.listArchived();
    await b.removeSpace("s");
    expect(invoke.mock.calls).toEqual([
      ["rename_space", { spaceId: "s", name: "New" }],
      ["set_space_color", { spaceId: "s", color: "#7DB8F5" }],
      ["archive_space", { spaceId: "s" }],
      ["unarchive_space", { spaceId: "s" }],
      ["list_archived", undefined],
      ["remove_space", { spaceId: "s" }],
    ]);
  });

  it("absolute path comes back as a string", async () => {
    invoke.mockResolvedValue("/home/me/wt/a.ts");
    expect(await b.absolutePath("s", "api", "a.ts")).toBe("/home/me/wt/a.ts");
    expect(invoke).toHaveBeenCalledWith("absolute_path", { spaceId: "s", repo: "api", path: "a.ts" });
  });
});
