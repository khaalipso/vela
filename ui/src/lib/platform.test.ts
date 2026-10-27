import { describe, expect, it } from "vitest";
import { keyText } from "./platform";

describe("key labels", () => {
  it("use the macOS symbols on a Mac only", () => {
    expect(keyText("Ctrl K", true)).toBe("⌘K");
    expect(keyText("Ctrl Shift `", true)).toBe("⌘⇧`");
    expect(keyText("Alt 1 to 9", true)).toBe("⌥1 to 9");
    expect(keyText("Ctrl K", false)).toBe("Ctrl K");
    expect(keyText("Y", true)).toBe("Y");
  });
});
