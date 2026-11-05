import { describe, expect, it } from "vitest";
import { compareCells, dataKind, parseCsv, parseJson, parseYaml, pathString, sniffDelimiter } from "./datafile";

describe("datafile", () => {
  it("recognizes the files", () => {
    expect(dataKind("r/a.CSV")).toBe("csv");
    expect(dataKind("r/a.tsv")).toBe("csv");
    expect(dataKind("r/a.json")).toBe("json");
    expect(dataKind("r/a.yml")).toBe("yaml");
    expect(dataKind("r/a.ts")).toBeNull();
  });
  it("parses quoted CSV cells", () => {
    expect(parseCsv('a,b\n"x,1","he said ""hi""\nthere"\r\n,\n')).toEqual([["a", "b"], ["x,1", 'he said "hi"\nthere'], ["", ""]]);
  });
  it("finds the delimiter", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter("a,b", "x.tsv")).toBe("\t");
  });
  it("sorts numbers as numbers and empties last", () => {
    expect(["10", "", "9", "b", "a"].sort(compareCells)).toEqual(["9", "10", "a", "b", ""]);
  });
  it("reads JSON, with comments and trailing commas as a fallback", () => {
    expect(parseJson('{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(parseJson('{\n// c\n"a": "x//y", /* z */\n}')).toEqual({ ok: true, value: { a: "x//y" } });
    expect(parseJson("{").ok).toBe(false);
  });
  it("reads YAML, several documents as a list", async () => {
    expect(await parseYaml("a:\n  - 1\n  - b")).toEqual({ ok: true, value: { a: [1, "b"] } });
    expect(await parseYaml("a: 1\n---\nb: 2")).toMatchObject({ ok: true, value: [{ a: 1 }, { b: 2 }], docs: 2 });
    expect((await parseYaml("a: [1")).ok).toBe(false);
  });
  it("writes a path", () => {
    expect(pathString(["a", "0", "b-c"], [false, true, false])).toBe('a[0]["b-c"]');
  });
});
