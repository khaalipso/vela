import { describe, expect, it } from "vitest";
import { parseCommitDiff } from "./commitdiff";

const DIFF = `diff --git a/a.txt b/a.txt
index 1..2 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,3 @@ fn x
 keep
-old
+new
+more
diff --git a/b.bin b/b.bin
new file mode 100644
Binary files /dev/null and b/b.bin differ
`;

describe("commit diff", () => {
  it("reads files, counts and line numbers", () => {
    const [a, b] = parseCommitDiff("api", DIFF);
    expect(a.path).toBe("a.txt");
    expect([a.added, a.removed]).toEqual([2, 1]);
    expect(a.hunks[0].section).toBe("fn x");
    expect(a.hunks[0].lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
    ]);
    expect(b.status).toBe("binary");
  });
});
