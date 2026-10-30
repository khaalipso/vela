import { describe, expect, it } from "vitest";
import { canBack, canForward, emptyHist, placeOf, record, step } from "./navhist";

const code = (f: string) => placeOf("code", f, "a1", "r1");

describe("navhist", () => {
  it("keeps only what the view shows", () => {
    expect(placeOf("agents", "f", "a1", "r1")).toEqual({ view: "agents", file: "", agent: "a1", row: "" });
  });
  it("goes back and forward, and a new place drops the forward part", () => {
    let h = emptyHist();
    for (const f of ["a", "b", "c"]) h = record(h, code(f));
    expect(canBack(h)).toBe(true);
    const back = step(h, -1)!;
    expect(back.place.file).toBe("b");
    expect(canForward(back.hist)).toBe(true);
    expect(step(back.hist, 1)!.place.file).toBe("c");
    const fork = record(back.hist, code("d"));
    expect(fork.stack.map((p) => p.file)).toEqual(["a", "b", "d"]);
    expect(canForward(fork)).toBe(false);
  });
  it("records the same place once and stops at the ends", () => {
    let h = record(emptyHist(), code("a"));
    expect(record(h, code("a"))).toBe(h);
    expect(step(h, -1)).toBeNull();
    expect(step(h, 1)).toBeNull();
  });
});
