// A search handle over a list of paths. Small lists are searched on the spot; big ones go to
// a Web Worker (when the platform has one), so filtering never blocks the UI thread.

import { FileIndex, type Hit } from "./fuzzy";

/** Above this many paths the search runs in a worker. */
export const WORKER_THRESHOLD = 20_000;

export type WorkerRequest = { type: "set"; paths: string[] } | { type: "search"; id: number; query: string; limit: number };
export interface WorkerReply {
  id: number;
  hits: Hit[];
}

/** The part of a Worker the matcher uses. */
export interface WorkerLike {
  postMessage(m: WorkerRequest): void;
  onmessage: ((e: { data: WorkerReply }) => void) | null;
  terminate(): void;
}

export interface Matcher {
  readonly size: number;
  /** Synchronous search, null when the list lives in a worker. */
  searchNow(query: string, limit: number): Hit[] | null;
  search(query: string, limit: number): Promise<Hit[]>;
  dispose(): void;
}

export interface MatcherOptions {
  threshold?: number;
  /** Creates the worker; return null for none. Defaults to the real `filesWorker.ts`. */
  spawn?: () => WorkerLike | null;
}

function defaultSpawn(): WorkerLike | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./filesWorker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
  } catch {
    return null;
  }
}

export function createMatcher(paths: string[], opts: MatcherOptions = {}): Matcher {
  const threshold = opts.threshold ?? WORKER_THRESHOLD;
  const worker = paths.length > threshold ? (opts.spawn ?? defaultSpawn)() : null;
  if (!worker) {
    const index = new FileIndex(paths);
    return {
      size: paths.length,
      searchNow: (q, limit) => index.search(q, limit),
      search: (q, limit) => Promise.resolve(index.search(q, limit)),
      dispose() {},
    };
  }
  const pending = new Map<number, (h: Hit[]) => void>();
  let seq = 0;
  worker.onmessage = (e) => {
    pending.get(e.data.id)?.(e.data.hits);
    pending.delete(e.data.id);
  };
  worker.postMessage({ type: "set", paths });
  return {
    size: paths.length,
    searchNow: () => null,
    search: (query, limit) =>
      new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        worker.postMessage({ type: "search", id, query, limit });
      }),
    dispose() {
      worker.terminate();
      for (const r of pending.values()) r([]);
      pending.clear();
    },
  };
}
