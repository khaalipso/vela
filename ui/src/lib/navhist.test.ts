import { describe, expect, it } from "vitest";
import { emptyHist, placeOf, record, step } from "./navhist";

const code = (f: string) => placeOf("code", f, "a1", "r1");
const files = (h: { stack: { file: string }[] }) => h.stack.map((p) => p.file);

describe("navhist", () => {
  it("keeps only what the view shows", () => {
    expect(placeOf("agents", "f", "a1", "r1")).toEqual({ view: "agents", file: "", agent: "a1", row: "" });
  });
  it("puts the place you reach first, and a place seen again moves up", () => {
    let h = emptyHist();
    for (const f of ["a", "b", "c", "a"]) h = record(h, code(f));
    expect(files(h)).toEqual(["a", "c", "b"]);
  });
  it("older twice comes back to where you started", () => {
    let h = emptyHist();
    for (const f of ["a", "b", "c"]) h = record(h, code(f)); // c, b, a
    const one = step(h, -1)!;
    expect(one.place.file).toBe("b");
    expect(files(one.hist)).toEqual(["b", "c", "a"]);
    const two = step(one.hist, -1)!;
    expect(two.place.file).toBe("c");
    expect(files(two.hist)).toEqual(["c", "b", "a"]);
  });
  it("the other way brings the oldest forward", () => {
    let h = emptyHist();
    for (const f of ["a", "b", "c"]) h = record(h, code(f));
    const r = step(h, 1)!;
    expect(r.place.file).toBe("a");
    expect(files(r.hist)).toEqual(["a", "c", "b"]);
  });
  it("records the same place once and has nowhere to go with one place", () => {
    const h = record(emptyHist(), code("a"));
    expect(record(h, code("a"))).toBe(h);
    expect(step(h, -1)).toBeNull();
    expect(step(h, 1)).toBeNull();
  });
});
