// Which answers you have read: per agent, the moment of the answer you last saw. A finished
// agent whose answer is newer than that shows a green dot in the list.

import type { Agent } from "./types";

const KEY = "vela.read";

function load(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The moment of the answer: it changes when the agent answers again. */
const stamp = (a: Agent) => `${a.status}|${a.finished ?? a.lastEvent ?? a.started ?? ""}`;

class Unread {
  read = $state<Record<string, string>>(load());

  private seeded = (() => {
    try {
      return localStorage.getItem(KEY) !== null;
    } catch {
      return true;
    }
  })();

  /** The first time: what already finished counts as read, only later answers are news. */
  seed(agents: Agent[]) {
    if (this.seeded || !agents.length) return;
    this.seeded = true;
    for (const a of agents) this.markRead(a);
  }

  /** A finished answer you have not opened yet. */
  isUnread(a: Agent): boolean {
    return a.status === "done" && this.read[a.id] !== stamp(a);
  }

  markRead(a: Agent) {
    if (a.status !== "done" || this.read[a.id] === stamp(a)) return;
    this.read = { ...this.read, [a.id]: stamp(a) };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.read));
    } catch {
      /* private mode: kept in memory */
    }
  }
}

export const unread = new Unread();
