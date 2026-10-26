import type { UpNext } from "./types";

/** Everything the island needs to know about the current space. */
export interface UpNextInput {
  /** Window the space lives in, null for this (main) window. */
  window: number | null;
  branch: string;
  /** Open question from an agent. `tool` is the display label, e.g. "Crush". */
  question: { tool: string; text: string } | null;
  /** Pending agent proposals. */
  pending: { repo: string; tool: string }[];
  /** Staged files across repos. */
  staged: { repo: string; path: string }[];
  /** Name of the next other space waiting for you, null if none. */
  nextWaiting: string | null;
}

export type UpNextActionName = "bring-here" | "answer" | "review" | "commit" | "next-space" | "ask";

export interface UpNextView {
  kind: UpNext | { type: "elsewhere"; window: number };
  title: string;
  sub: string;
  /** Label of the action button. */
  go: string;
  /** Key shown on the action button. */
  key: string;
  /** Quiet style: nothing urgent here. */
  quiet: boolean;
  action: UpNextActionName;
}

const uniq = <T>(a: T[]): T[] => a.filter((x, i) => a.indexOf(x) === i);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function readyToCommit(i: Pick<UpNextInput, "pending" | "question" | "staged">): boolean {
  return i.pending.length === 0 && !i.question && i.staged.length > 0;
}

/** Number shown on the rail: question + pending proposals + a commit waiting. */
export function waitingCount(i: Pick<UpNextInput, "pending" | "question" | "staged">): number {
  return (i.question ? 1 : 0) + i.pending.length + (readyToCommit(i) ? 1 : 0);
}

export function computeUpNext(i: UpNextInput): UpNextView {
  if (i.window !== null) {
    return {
      kind: { type: "elsewhere", window: i.window },
      title: `This space is open in window ${i.window}`,
      sub: "Press W to bring it here",
      go: "Bring here",
      key: "Enter",
      quiet: false,
      action: "bring-here",
    };
  }
  if (i.question) {
    return {
      kind: { type: "agentQuestion", agent: i.question.tool, text: i.question.text },
      title: `${i.question.tool} is waiting for you`,
      sub: i.question.text,
      go: "Answer",
      key: "Enter",
      quiet: false,
      action: "answer",
    };
  }
  if (i.pending.length) {
    const repos = uniq(i.pending.map((h) => h.repo));
    const tools = uniq(i.pending.map((h) => h.tool));
    return {
      kind: { type: "review", count: i.pending.length },
      title: `Review ${plural(i.pending.length, "proposal", "proposals")}`,
      sub: `in ${repos.join(", ")} · from ${tools.join(", ")}`,
      go: "Review",
      key: "Enter",
      quiet: false,
      action: "review",
    };
  }
  if (readyToCommit(i)) {
    const repos = uniq(i.staged.map((f) => f.repo)).length;
    return {
      kind: { type: "commit", repos, files: i.staged.length },
      title: `Commit and push ${plural(repos, "repo", "repos")}`,
      sub: `${i.branch} · ${i.staged.length} files staged`,
      go: "Commit",
      key: "Enter",
      quiet: false,
      action: "commit",
    };
  }
  if (i.nextWaiting !== null) {
    return {
      kind: { type: "nothing" },
      title: "Nothing waiting here",
      sub: `${i.nextWaiting} needs you`,
      go: "Next space",
      key: "Shift Enter",
      quiet: true,
      action: "next-space",
    };
  }
  return {
    kind: { type: "nothing" },
    title: "Nothing waiting",
    sub: "Ask an agent or keep typing",
    go: "Ask",
    key: "@",
    quiet: true,
    action: "ask",
  };
}
