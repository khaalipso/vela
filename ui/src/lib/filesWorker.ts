// Web Worker: holds a FileIndex and answers searches, so a huge tree never blocks typing.
import { FileIndex } from "./fuzzy";
import type { WorkerReply, WorkerRequest } from "./matcher";

let index = new FileIndex([]);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  if (m.type === "set") index = new FileIndex(m.paths);
  else {
    const reply: WorkerReply = { id: m.id, hits: index.search(m.query, m.limit) };
    (self as unknown as { postMessage(r: WorkerReply): void }).postMessage(reply);
  }
};
