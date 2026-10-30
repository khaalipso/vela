import { describe, expect, it } from "vitest";
import { collapsePaste, draftOf, expandPasted, pastedIn, restorePasted, setDraft } from "./paste";

function paste(text: string, value = "") {
  const el = { value, selectionStart: value.length, selectionEnd: value.length } as HTMLTextAreaElement;
  let prevented = false;
  const e = { clipboardData: { getData: () => text }, preventDefault: () => (prevented = true) } as unknown as ClipboardEvent;
  return { r: collapsePaste(e, el), prevented };
}

describe("long pastes", () => {
  it("leaves short pastes to the field", () => {
    const { r, prevented } = paste("a\nb\nc\nd\ne");
    expect(r).toBeNull();
    expect(prevented).toBe(false);
  });
  it("hides a long paste behind a token, sends the text, restores on click", () => {
    const long = "1\n2\n3\n4\n5\n6";
    const { r } = paste(long, "see: ");
    expect(r!.value).toMatch(/^see: \[Pasted text #\d+ · 6 lines\]$/);
    expect(pastedIn(r!.value)).toHaveLength(1);
    expect(expandPasted(r!.value)).toBe(`see: ${long}`);
    const token = pastedIn(r!.value)[0].token;
    expect(restorePasted(r!.value, token)).toBe(`see: ${long}`);
    expect(pastedIn(restorePasted(r!.value, token))).toHaveLength(0);
  });
  it("keeps drafts by field", () => {
    setDraft("dev-1", "half a thought");
    expect(draftOf("dev-1")).toBe("half a thought");
    setDraft("dev-1", "");
    expect(draftOf("dev-1")).toBe("");
  });
});
