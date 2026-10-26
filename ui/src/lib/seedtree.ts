// Realistic file lists for the mock backend, and a big synthetic list for performance tests.

const WORDS = [
  "billing", "invoice", "checkout", "customer", "webhook", "stripe", "refund", "payment", "session", "token",
  "account", "ledger", "report", "export", "import", "queue", "worker", "retry", "cache", "config",
  "auth", "user", "role", "audit", "event", "mailer", "search", "index", "schema", "client",
];
const EXT = ["ts", "ts", "ts", "tsx", "js", "json", "md", "sql", "yml"];

/** Small deterministic generator, so the mock tree is the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** `count` paths spread over nested folders. */
export function syntheticPaths(count: number, seed = 7): string[] {
  const r = rng(seed);
  const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)];
  const roots = ["src", "lib", "tests", "packages", "docs", "scripts", "migrations"];
  const out = new Set<string>();
  let n = 0;
  while (out.size < count) {
    const depth = 1 + Math.floor(r() * 4);
    const dirs: string[] = [pick(roots)];
    for (let i = 0; i < depth; i++) dirs.push(pick(WORDS));
    const name = `${pick(WORDS)}${r() < 0.3 ? "_" + pick(WORDS) : ""}${r() < 0.2 ? pick(WORDS).toUpperCase().slice(0, 1) + "x" : ""}${n++ % 7 === 0 ? n : ""}`;
    out.add(`${dirs.join("/")}/${name}.${pick(EXT)}`);
  }
  return [...out].sort();
}

/** A few hundred files for a mock repo, with the usual root files. */
export function repoPaths(repo: string): string[] {
  const seed = [...repo].reduce((a, c) => a * 31 + c.charCodeAt(0), 17);
  const root = ["README.md", "package.json", "tsconfig.json", ".gitignore", "AGENTS.md", "compose.yml"];
  return [...new Set([...root, ...syntheticPaths(180 + (seed % 90), seed)])].sort();
}

/** Lines the mock shows for a generated file. */
export function fakeContent(path: string): string[] {
  const base = path.split("/").pop() ?? path;
  const name = base.replace(/\.[^.]+$/, "").replace(/\W+/g, "_");
  if (path.endsWith(".md")) return [`# ${base}`, "", "Notes for this part of the project."];
  if (path.endsWith(".json")) return ["{", `  "name": "${name}"`, "}"];
  if (path.endsWith(".sql")) return [`-- ${base}`, `select 1 as ${name};`];
  if (path.endsWith(".yml")) return [`${name}:`, "  enabled: true"];
  return [`export function ${name}() {`, `  return "${path}"`, "}"];
}
