// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { linkFiles, resolveFile } from "./filelinks";

const files = [
  { repo: "infra", path: "terragrunt/main/terragrunt.hcl" },
  { repo: "infra", path: "README.md" },
  { repo: "api", path: "README.md" },
  { repo: "api", path: "src/main.rs" },
];

describe("resolveFile", () => {
  it("takes repo/path, a path inside a repo, and the tail of a path", () => {
    expect(resolveFile("infra/terragrunt/main/terragrunt.hcl", files)).toEqual(files[0]);
    expect(resolveFile("terragrunt/main/terragrunt.hcl", files)).toEqual(files[0]);
    expect(resolveFile("/home/me/Work/api/src/main.rs", files)).toEqual(files[3]);
    expect(resolveFile("./src/main.rs:42", files)).toEqual(files[3]);
  });
  it("refuses what is ambiguous or not a path", () => {
    expect(resolveFile("README.md", files)).toBeNull();
    expect(resolveFile("api/README.md", files)).toEqual(files[2]);
    expect(resolveFile("cargo build", files)).toBeNull();
    expect(resolveFile("nothing", files)).toBeNull();
    expect(resolveFile("missing/file.rs", files)).toBeNull();
  });
});

describe("linkFiles", () => {
  it("links inline code that names a file, not code blocks", () => {
    const out = linkFiles("<p>J'ai modifié <code>terragrunt/main/terragrunt.hcl</code></p><pre><code>src/main.rs</code></pre>", files);
    expect(out).toContain('<a class="filelink"');
    expect(out).toContain('data-repo="infra"');
    expect(out.match(/filelink/g)).toHaveLength(1);
  });
  it("leaves the html alone when nothing matches", () => {
    const html = "<p><code>foo</code></p>";
    expect(linkFiles(html, files)).toBe(html);
  });
});
