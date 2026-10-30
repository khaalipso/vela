import { describe, expect, it } from "vitest";
import { splitAnswer } from "./answer";

describe("splitAnswer", () => {
  it("cuts the outcome and the sections", () => {
    const a = splitAnswer("Fixed the refund webhook.\n\n## Changes\n- a.rs:1\n\n### Checked\n`cargo test` passes");
    expect(a.lead).toBe("Fixed the refund webhook.");
    expect(a.sections.map((s) => s.title)).toEqual(["Changes", "Checked"]);
    expect(a.sections[0].body).toBe("- a.rs:1");
  });

  it("ignores headings inside code blocks", () => {
    const a = splitAnswer("Done.\n\n## Changes\n```md\n## not a section\n```");
    expect(a.sections).toHaveLength(1);
    expect(a.sections[0].body).toContain("## not a section");
  });

  it("keeps an answer without sections as a lead", () => {
    expect(splitAnswer("Just text.")).toEqual({ lead: "Just text.", sections: [] });
  });

  it("starts long sections closed", () => {
    expect(splitAnswer(`## A\n${"x".repeat(800)}`).sections[0].long).toBe(true);
  });
});
