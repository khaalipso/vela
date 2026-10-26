import { describe, expect, it } from "vitest";
import { computeUpNext, readyToCommit, waitingCount, type UpNextInput } from "./upnext";

const base = (o: Partial<UpNextInput> = {}): UpNextInput => ({
  window: null,
  branch: "feat/x",
  question: null,
  pending: [],
  staged: [],
  nextWaiting: null,
  ...o,
});

describe("computeUpNext", () => {
  it("space in another window comes first", () => {
    const u = computeUpNext(base({ window: 2, question: { tool: "Crush", text: "?" } }));
    expect(u.kind).toEqual({ type: "elsewhere", window: 2 });
    expect(u.title).toBe("This space is open in window 2");
    expect(u.sub).toBe("Press W to bring it here");
    expect(u.action).toBe("bring-here");
    expect(u.go).toBe("Bring here");
    expect(u.quiet).toBe(false);
  });

  it("an agent question beats proposals", () => {
    const u = computeUpNext(
      base({ question: { tool: "Crush", text: "Keep it?" }, pending: [{ repo: "api", tool: "Crush" }] }),
    );
    expect(u.kind).toEqual({ type: "agentQuestion", agent: "Crush", text: "Keep it?" });
    expect(u.title).toBe("Crush is waiting for you");
    expect(u.sub).toBe("Keep it?");
    expect(u.go).toBe("Answer");
    expect(u.action).toBe("answer");
  });

  it("review: singular and plural, repos and tools deduplicated", () => {
    const one = computeUpNext(base({ pending: [{ repo: "api", tool: "Claude Code" }] }));
    expect(one.title).toBe("Review 1 proposal");
    expect(one.sub).toBe("in api · from Claude Code");
    const many = computeUpNext(
      base({
        pending: [
          { repo: "api", tool: "Claude Code" },
          { repo: "web", tool: "Claude Code" },
          { repo: "api", tool: "opencode" },
        ],
      }),
    );
    expect(many.kind).toEqual({ type: "review", count: 3 });
    expect(many.title).toBe("Review 3 proposals");
    expect(many.sub).toBe("in api, web · from Claude Code, opencode");
    expect(many.action).toBe("review");
    expect(many.go).toBe("Review");
  });

  it("commit when everything is reviewed and something is staged", () => {
    const one = computeUpNext(base({ staged: [{ repo: "api", path: "a.ts" }] }));
    expect(one.kind).toEqual({ type: "commit", repos: 1, files: 1 });
    expect(one.title).toBe("Commit and push 1 repo");
    expect(one.sub).toBe("feat/x · 1 files staged");
    const two = computeUpNext(
      base({
        staged: [
          { repo: "api", path: "a.ts" },
          { repo: "api", path: "b.ts" },
          { repo: "web", path: "c.ts" },
        ],
      }),
    );
    expect(two.kind).toEqual({ type: "commit", repos: 2, files: 3 });
    expect(two.title).toBe("Commit and push 2 repos");
    expect(two.action).toBe("commit");
  });

  it("quiet: another space needs you", () => {
    const u = computeUpNext(base({ nextWaiting: "Postgres 17" }));
    expect(u.quiet).toBe(true);
    expect(u.kind).toEqual({ type: "nothing" });
    expect(u.title).toBe("Nothing waiting here");
    expect(u.sub).toBe("Postgres 17 needs you");
    expect(u.go).toBe("Next space");
    expect(u.key).toBe("Shift Enter");
    expect(u.action).toBe("next-space");
  });

  it("quiet: nothing anywhere", () => {
    const u = computeUpNext(base());
    expect(u.quiet).toBe(true);
    expect(u.title).toBe("Nothing waiting");
    expect(u.sub).toBe("Ask an agent or keep typing");
    expect(u.go).toBe("Ask");
    expect(u.key).toBe("@");
    expect(u.action).toBe("ask");
  });

  it("commit wins over a waiting space", () => {
    const u = computeUpNext(base({ staged: [{ repo: "api", path: "a" }], nextWaiting: "Other" }));
    expect(u.action).toBe("commit");
  });
});

describe("waitingCount", () => {
  it("counts the question, each proposal and a commit", () => {
    expect(waitingCount(base())).toBe(0);
    expect(waitingCount(base({ question: { tool: "x", text: "y" } }))).toBe(1);
    expect(waitingCount(base({ pending: [{ repo: "a", tool: "t" }, { repo: "b", tool: "t" }] }))).toBe(2);
    expect(waitingCount(base({ staged: [{ repo: "a", path: "p" }] }))).toBe(1);
    expect(
      waitingCount(base({ question: { tool: "x", text: "y" }, staged: [{ repo: "a", path: "p" }] })),
    ).toBe(1);
  });

  it("readyToCommit needs staged files and nothing else open", () => {
    expect(readyToCommit(base())).toBe(false);
    expect(readyToCommit(base({ staged: [{ repo: "a", path: "p" }] }))).toBe(true);
    expect(readyToCommit(base({ staged: [{ repo: "a", path: "p" }], pending: [{ repo: "a", tool: "t" }] }))).toBe(false);
  });
});
