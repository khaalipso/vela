import { describe, expect, it } from "vitest";
import { FileIndex, fuzzyMatch } from "./fuzzy";
import { createMatcher, type WorkerLike, type WorkerReply, type WorkerRequest } from "./matcher";
import { syntheticPaths } from "./seedtree";

const best = (q: string, paths: string[]) => new FileIndex(paths).search(q).map((h) => paths[h.index]);

describe("scorer", () => {
  it("needs the characters in order", () => {
    expect(fuzzyMatch("wbk", "src/billing/webhook.ts")).not.toBeNull();
    expect(fuzzyMatch("kbw", "src/billing/webhook.ts")).toBeNull();
    expect(fuzzyMatch("x", "src/a.ts")).toBeNull();
  });

  it("returns the matched positions", () => {
    expect(fuzzyMatch("wh", "src/webhook.ts")!.positions).toEqual([4, 7]);
    expect(fuzzyMatch("src", "src/a.ts")!.positions).toEqual([0, 1, 2]);
  });

  it("prefers consecutive characters", () => {
    expect(best("hook", ["src/h_o_o_k.ts", "src/hook.ts"])[0]).toBe("src/hook.ts");
  });

  it("prefers the basename to a folder name", () => {
    expect(best("stripe", ["src/stripe/client.ts", "lib/stripe.ts"])[0]).toBe("lib/stripe.ts");
  });

  it("rewards word boundaries and camelCase", () => {
    expect(best("uc", ["src/document_cache.ts", "src/user_controller.ts"])[0]).toBe("src/user_controller.ts");
    expect(best("fb", ["src/fxxxxbxxx.ts", "src/fooBar.ts"])[0]).toBe("src/fooBar.ts");
  });

  it("an exact basename wins, then a shorter path breaks ties", () => {
    expect(best("index", ["src/reindexer.ts", "src/index.ts"])[0]).toBe("src/index.ts");
    expect(best("a", ["x/yy/zz/a.ts", "x/a.ts"])).toEqual(["x/a.ts", "x/yy/zz/a.ts"]);
  });

  it("is case-insensitive and ignores spaces in the query", () => {
    expect(best("WEB hook", ["src/webhook.ts"])).toEqual(["src/webhook.ts"]);
  });

  it("limits the results and keeps the best ones", () => {
    const paths = Array.from({ length: 500 }, (_, i) => `d${i}/file${i}.ts`).concat(["exact/f.ts"]);
    const hits = new FileIndex(paths).search("f", 10);
    expect(hits).toHaveLength(10);
    expect(paths[hits[0].index]).toBe("exact/f.ts");
  });
});

describe("matcher", () => {
  it("searches on the spot below the threshold", async () => {
    const m = createMatcher(["a/b.ts", "c.ts"]);
    expect(m.searchNow("b", 5)).toHaveLength(1);
    expect(await m.search("c", 5)).toHaveLength(1);
  });

  it("goes through a worker above the threshold", async () => {
    const paths = ["a/b.ts", "c/d.ts", "e/f.ts"];
    let idx = new FileIndex([]);
    const fake: WorkerLike = {
      onmessage: null,
      terminate() {},
      postMessage(m: WorkerRequest) {
        if (m.type === "set") idx = new FileIndex(m.paths);
        else setTimeout(() => fake.onmessage?.({ data: { id: m.id, hits: idx.search(m.query, m.limit) } satisfies WorkerReply }));
      },
    };
    const m = createMatcher(paths, { threshold: 1, spawn: () => fake });
    expect(m.searchNow("d", 5)).toBeNull();
    const hits = await m.search("d", 5);
    expect(paths[hits[0].index]).toBe("c/d.ts");
  });
});

describe("performance", () => {
  it("filters 50k paths in well under 50 ms", () => {
    const paths = syntheticPaths(50_000);
    expect(paths.length).toBe(50_000);
    const idx = new FileIndex(paths);
    idx.search("warm", 10); // let the JIT see the code once
    for (const q of ["bill", "stwh", "usercfg", "a"]) {
      // Best of 5 runs: the suite runs files in parallel, so one run can be preempted.
      let ms = Infinity;
      let hits: unknown[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        hits = idx.search(q, 2000);
        ms = Math.min(ms, performance.now() - t);
      }
      expect(hits.length).toBeGreaterThan(0);
      expect(ms, `query ${q}`).toBeLessThan(50);
    }
  });
});
