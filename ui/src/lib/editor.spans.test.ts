import { describe, expect, it } from "vitest";
import { changeSpans } from "./editor";

describe("changeSpans", () => {
  it("marks only the text that changed on a modified line", () => {
    const h = { lines: [{ kind: "del", text: "let a = 1;", new: null }, { kind: "add", text: "let a = 42;", new: 3 }] };
    expect(changeSpans([h], 1, 5)).toEqual([{ line: 3, from: 8, to: 10 }]);
  });
  it("marks an added line without its indent", () => {
    const h = { lines: [{ kind: "add", text: "  foo();  ", new: 2 }] };
    expect(changeSpans([h], 1, 5)).toEqual([{ line: 2, from: 2, to: 8 }]);
  });
});
