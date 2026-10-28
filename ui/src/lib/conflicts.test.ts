import { describe, expect, it } from "vitest";
import { findConflicts, resolve } from "./conflicts";

const text = "a\n<<<<<<< yours\nmine 1\n=======\nagent 1\n>>>>>>> agent\nb\n<<<<<<< yours\n=======\nagent 2\n>>>>>>> agent\nc\n";

describe("conflicts", () => {
  it("finds each block with both sides", () => {
    const c = findConflicts(text);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ line: 2, mine: "mine 1\n", theirs: "agent 1\n" });
    expect(c[1]).toMatchObject({ line: 8, mine: "", theirs: "agent 2\n" });
  });
  it("resolves one, then all", () => {
    expect(resolve(text, "mine", 0)).toBe("a\nmine 1\nb\n<<<<<<< yours\n=======\nagent 2\n>>>>>>> agent\nc\n");
    expect(resolve(text, "theirs")).toBe("a\nagent 1\nb\nagent 2\nc\n");
    expect(resolve(text, "both")).toBe("a\nmine 1\nagent 1\nb\nagent 2\nc\n");
  });
  it("ignores an unfinished block", () => {
    expect(findConflicts("<<<<<<< yours\nx\n=======\n")).toEqual([]);
  });
});
