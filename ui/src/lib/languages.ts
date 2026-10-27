// Languages of the editor: which one a file is, and its CodeMirror support, loaded on demand
// so the parsers are only downloaded when a file of that language is opened.

import type { Extension } from "@codemirror/state";

export type Lang =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "json"
  | "html"
  | "css"
  | "scss"
  | "sass"
  | "less"
  | "vue"
  | "svelte"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "kotlin"
  | "scala"
  | "csharp"
  | "dart"
  | "c"
  | "cpp"
  | "php"
  | "ruby"
  | "swift"
  | "lua"
  | "shell"
  | "powershell"
  | "toml"
  | "ini"
  | "yaml"
  | "sql"
  | "markdown"
  | "xml"
  | "dockerfile"
  | "nginx"
  | "diff"
  | "r"
  | "perl"
  | "haskell"
  | "elixir"
  | "erlang"
  | "clojure"
  | "plain";

const BY_EXT: Record<string, Lang> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  webmanifest: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  vue: "vue",
  svelte: "svelte",
  astro: "html",
  py: "python",
  pyi: "python",
  pyw: "python",
  ipynb: "json",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  cs: "csharp",
  dart: "dart",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  m: "c",
  mm: "cpp",
  php: "php",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  swift: "swift",
  lua: "lua",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  env: "ini",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  xsd: "xml",
  dockerfile: "dockerfile",
  diff: "diff",
  patch: "diff",
  r: "r",
  pl: "perl",
  pm: "perl",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  cljs: "clojure",
  edn: "clojure",
};

const BY_NAME: Record<string, Lang> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "shell",
  gemfile: "ruby",
  rakefile: "ruby",
  vagrantfile: "ruby",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
  ".envrc": "shell",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  "cargo.lock": "toml",
  "pipfile": "toml",
  "nginx.conf": "nginx",
};

/** The language of a file, from its name, then its extension. */
export function languageOf(path: string): Lang {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  if (name.startsWith(".env")) return "ini";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return BY_EXT[ext] ?? "plain";
}

async function legacy(load: () => Promise<Record<string, unknown>>, name: string): Promise<Extension> {
  const [{ StreamLanguage }, mod] = await Promise.all([import("@codemirror/language"), load()]);
  return StreamLanguage.define(mod[name] as never);
}

const cache = new Map<Lang, Promise<Extension>>();

/** The CodeMirror support of a language; loaded once, then reused. */
export function loadLanguage(l: Lang): Promise<Extension> {
  let p = cache.get(l);
  if (!p) {
    p = build(l).catch(() => [] as Extension);
    cache.set(l, p);
  }
  return p;
}

async function build(l: Lang): Promise<Extension> {
  switch (l) {
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "html":
    case "svelte":
      return (await import("@codemirror/lang-html")).html();
    case "vue":
      return (await import("@codemirror/lang-vue")).vue();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "scss":
      return (await import("@codemirror/lang-sass")).sass();
    case "sass":
      return (await import("@codemirror/lang-sass")).sass({ indented: true });
    case "less":
      return (await import("@codemirror/lang-css")).css();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "c":
    case "cpp":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "php":
      return (await import("@codemirror/lang-php")).php();
    case "xml":
      return (await import("@codemirror/lang-xml")).xml();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "markdown": {
      const [{ markdown, markdownLanguage }, { languages }] = await Promise.all([
        import("@codemirror/lang-markdown"),
        import("@codemirror/language-data").catch(() => ({ languages: [] })),
      ]);
      return markdown({ base: markdownLanguage, codeLanguages: languages });
    }
    case "kotlin":
      return legacy(() => import("@codemirror/legacy-modes/mode/clike"), "kotlin");
    case "scala":
      return legacy(() => import("@codemirror/legacy-modes/mode/clike"), "scala");
    case "csharp":
      return legacy(() => import("@codemirror/legacy-modes/mode/clike"), "csharp");
    case "dart":
      return legacy(() => import("@codemirror/legacy-modes/mode/clike"), "dart");
    case "ruby":
      return legacy(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby");
    case "swift":
      return legacy(() => import("@codemirror/legacy-modes/mode/swift"), "swift");
    case "lua":
      return legacy(() => import("@codemirror/legacy-modes/mode/lua"), "lua");
    case "shell":
      return legacy(() => import("@codemirror/legacy-modes/mode/shell"), "shell");
    case "powershell":
      return legacy(() => import("@codemirror/legacy-modes/mode/powershell"), "powerShell");
    case "toml":
      return legacy(() => import("@codemirror/legacy-modes/mode/toml"), "toml");
    case "ini":
      return legacy(() => import("@codemirror/legacy-modes/mode/properties"), "properties");
    case "dockerfile":
      return legacy(() => import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile");
    case "nginx":
      return legacy(() => import("@codemirror/legacy-modes/mode/nginx"), "nginx");
    case "diff":
      return legacy(() => import("@codemirror/legacy-modes/mode/diff"), "diff");
    case "r":
      return legacy(() => import("@codemirror/legacy-modes/mode/r"), "r");
    case "perl":
      return legacy(() => import("@codemirror/legacy-modes/mode/perl"), "perl");
    case "haskell":
      return legacy(() => import("@codemirror/legacy-modes/mode/haskell"), "haskell");
    case "erlang":
      return legacy(() => import("@codemirror/legacy-modes/mode/erlang"), "erlang");
    case "clojure":
      return legacy(() => import("@codemirror/legacy-modes/mode/clojure"), "clojure");
    case "elixir":
      return legacy(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby");
    default:
      return [];
  }
}
