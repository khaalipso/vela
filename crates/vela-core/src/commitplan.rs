//! Commit composer: split the staged diff into commits, write conventional messages,
//! validate them against the repo rules and commit group by group.
//!
//! Everything before [`commit_groups`] is read-only. Subjects are guesses made from paths;
//! TODO(M2): let an agent improve them.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use crate::diff::{ParsedFile, hunk_id, staged_files};
use crate::error::{Error, Result};
use crate::git::{git, git_with};
use crate::model::{
    CommitGroup, CommitPlan, CommitRules, CommitType, DiffLine, LineKind, Link, LinkKind, Problem,
    Space, SpaceRepo,
};

pub const DEFAULT_TYPES: &[&str] = &[
    "feat", "fix", "refactor", "perf", "test", "docs", "style", "build", "ci", "chore", "revert",
];
pub const DEFAULT_HEADER_MAX: u32 = 72;

impl CommitType {
    pub fn as_str(self) -> &'static str {
        match self {
            CommitType::Feat => "feat",
            CommitType::Fix => "fix",
            CommitType::Refactor => "refactor",
            CommitType::Perf => "perf",
            CommitType::Test => "test",
            CommitType::Docs => "docs",
            CommitType::Style => "style",
            CommitType::Build => "build",
            CommitType::Ci => "ci",
            CommitType::Chore => "chore",
            CommitType::Revert => "revert",
        }
    }
}

impl Default for CommitRules {
    fn default() -> Self {
        CommitRules {
            types: DEFAULT_TYPES.iter().map(|s| s.to_string()).collect(),
            scopes: Vec::new(),
            header_max: DEFAULT_HEADER_MAX,
        }
    }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/// `feat(billing)!: add refunds module`, or just the subject outside conventional repos.
pub fn header(g: &CommitGroup, conventional: bool) -> String {
    if !conventional {
        return g.subject.trim().to_string();
    }
    let scope = g
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("({s})"))
        .unwrap_or_default();
    let bang = if g.breaking { "!" } else { "" };
    format!("{}{scope}{bang}: {}", g.kind.as_str(), g.subject.trim())
}

/// Full message: header, body, then footers (and `BREAKING CHANGE:` when conventional).
pub fn compose_message(g: &CommitGroup, conventional: bool) -> String {
    let mut msg = header(g, conventional);
    let body = g.body.trim();
    if !body.is_empty() {
        msg.push_str("\n\n");
        msg.push_str(body);
    }
    let mut footers: Vec<String> = g
        .footers
        .iter()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect();
    if conventional && g.breaking {
        let reason = g
            .breaking_reason
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .unwrap_or(g.subject.trim());
        footers.insert(0, format!("BREAKING CHANGE: {reason}"));
    }
    if !footers.is_empty() {
        msg.push_str("\n\n");
        msg.push_str(&footers.join("\n"));
    }
    msg
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn problem(field: &str, message: impl Into<String>) -> Problem {
    Problem {
        field: field.to_string(),
        message: message.into(),
    }
}

/// Split `type(scope)!: subject` into its parts. `None` when the header has no `: `.
fn parse_header(header: &str) -> Option<(String, Option<String>, bool, String)> {
    let (left, subject) = header.split_once(": ").or_else(|| {
        // "feat:" with nothing after it.
        header.strip_suffix(':').map(|l| (l, ""))
    })?;
    let (left, bang) = match left.strip_suffix('!') {
        Some(l) => (l, true),
        None => (left, false),
    };
    let (ty, scope) = match left.split_once('(') {
        Some((t, rest)) => (t, Some(rest.strip_suffix(')')?.to_string())),
        None => (left, None),
    };
    if ty.is_empty() || !ty.chars().all(|c| c.is_ascii_lowercase()) {
        return None;
    }
    Some((ty.to_string(), scope, bang, subject.to_string()))
}

/// Does a commit subject look like `type(scope)!: subject`?
pub fn is_conventional_subject(s: &str) -> bool {
    matches!(parse_header(s), Some((_, scope, _, subject))
        if !subject.trim().is_empty() && scope.as_deref().is_none_or(|s| !s.is_empty()))
}

/// Check a conventional message against the repo rules.
pub fn validate(message: &str, rules: &CommitRules) -> Vec<Problem> {
    let mut out = Vec::new();
    let mut lines = message.lines();
    let head = lines.next().unwrap_or("").trim_end();
    match parse_header(head) {
        None => out.push(problem(
            "header",
            "Header must look like type(scope): subject",
        )),
        Some((ty, scope, _, subject)) => {
            if !rules.types.is_empty() && !rules.types.contains(&ty) {
                out.push(problem(
                    "type",
                    format!(
                        "Type {ty} is not allowed, use one of: {}",
                        rules.types.join(", ")
                    ),
                ));
            }
            if let Some(scope) = scope {
                if scope.trim().is_empty() {
                    out.push(problem("scope", "Scope is empty, drop the parentheses"));
                } else if !rules.scopes.is_empty() {
                    for s in scope.split(',').map(str::trim) {
                        if !rules.scopes.iter().any(|r| r == s) {
                            out.push(problem(
                                "scope",
                                format!(
                                    "Scope {s} is not allowed, use one of: {}",
                                    rules.scopes.join(", ")
                                ),
                            ));
                        }
                    }
                }
            }
            check_subject(&subject, &mut out);
        }
    }
    check_length_and_body(head, message, rules, &mut out);
    out
}

fn check_subject(subject: &str, out: &mut Vec<Problem>) {
    let s = subject.trim();
    if s.is_empty() {
        out.push(problem("subject", "Subject is empty"));
    } else if s.ends_with('.') {
        out.push(problem("subject", "Subject must not end with a period"));
    }
}

fn check_length_and_body(head: &str, message: &str, rules: &CommitRules, out: &mut Vec<Problem>) {
    let n = head.chars().count();
    if rules.header_max > 0 && n > rules.header_max as usize {
        out.push(problem(
            "header",
            format!(
                "Header is {n} characters, the limit is {}",
                rules.header_max
            ),
        ));
    }
    if let Some(second) = message.lines().nth(1)
        && !second.trim().is_empty()
    {
        out.push(problem("body", "Leave a blank line after the header"));
    }
}

/// Rules for a repo that does not use conventional commits: only the basics.
pub fn validate_plain(message: &str, rules: &CommitRules) -> Vec<Problem> {
    let mut out = Vec::new();
    let head = message.lines().next().unwrap_or("").trim_end();
    check_subject(head, &mut out);
    check_length_and_body(head, message, rules, &mut out);
    out
}

/// [`validate`] when the repo is conventional, [`validate_plain`] otherwise.
pub fn validate_for(message: &str, rules: &CommitRules, conventional: bool) -> Vec<Problem> {
    if conventional {
        validate(message, rules)
    } else {
        validate_plain(message, rules)
    }
}

// ---------------------------------------------------------------------------
// Repo conventions
// ---------------------------------------------------------------------------

/// Share of the last 30 subjects that must be conventional for the repo to count as such.
const CONVENTIONAL_SHARE: f64 = 0.6;

const COMMITLINT_FILES: &[&str] = &[
    ".commitlintrc",
    ".commitlintrc.json",
    ".commitlintrc.yaml",
    ".commitlintrc.yml",
    ".commitlintrc.js",
    ".commitlintrc.cjs",
    ".commitlintrc.mjs",
    ".commitlintrc.ts",
    "commitlint.config.js",
    "commitlint.config.cjs",
    "commitlint.config.mjs",
    "commitlint.config.ts",
];

/// Rules from the text of a JSON commitlint config. Missing or disabled rules keep defaults.
pub fn parse_commitlint(text: &str) -> CommitRules {
    let mut rules = CommitRules::default();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return rules;
    };
    let rule = |name: &str| {
        let r = v.get("rules")?.get(name)?.as_array()?;
        // [level, applicability, value]; level 0 means the rule is off.
        if r.first()?.as_u64() == Some(0) {
            return None;
        }
        r.get(2).cloned()
    };
    let strings = |v: serde_json::Value| -> Option<Vec<String>> {
        Some(
            v.as_array()?
                .iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect(),
        )
    };
    if let Some(t) = rule("type-enum").and_then(strings)
        && !t.is_empty()
    {
        rules.types = t;
    }
    if let Some(s) = rule("scope-enum").and_then(strings) {
        rules.scopes = s;
    }
    if let Some(n) = rule("header-max-length").and_then(|n| n.as_u64()) {
        rules.header_max = n as u32;
    }
    rules
}

/// Is the repo conventional, and what are its rules?
///
/// Conventional when a commitlint config exists, or when at least 60% of the
/// last 30 subjects on the base branch are conventional. `type-enum`,
/// `scope-enum` and `header-max-length` are read from `.commitlintrc` or
/// `.commitlintrc.json` (JSON only).
pub fn detect_conventions(repo: &SpaceRepo) -> (bool, CommitRules) {
    let mut rules = CommitRules::default();
    let mut conventional = false;
    for dir in [&repo.worktree, &repo.source] {
        let dir = Path::new(dir);
        if let Some(name) = COMMITLINT_FILES.iter().find(|n| dir.join(n).is_file()) {
            conventional = true;
            if (*name == ".commitlintrc" || *name == ".commitlintrc.json")
                && let Ok(text) = fs::read_to_string(dir.join(name))
            {
                rules = parse_commitlint(&text);
            }
            break;
        }
    }
    if !conventional {
        let subjects = git(
            Path::new(&repo.worktree),
            &["log", "-30", "--format=%s", &repo.base],
        )
        .unwrap_or_default();
        let all: Vec<&str> = subjects.lines().collect();
        let hits = all.iter().filter(|s| is_conventional_subject(s)).count();
        conventional = !all.is_empty() && hits as f64 / all.len() as f64 >= CONVENTIONAL_SHARE;
    }
    (conventional, rules)
}

// ---------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn segments(path: &str) -> Vec<&str> {
    path.split('/').collect()
}

pub fn is_test_path(path: &str) -> bool {
    let segs = segments(path);
    let dirs = &segs[..segs.len().saturating_sub(1)];
    let name = file_name(path);
    dirs.iter()
        .any(|d| matches!(*d, "test" | "tests" | "__tests__"))
        || name.contains(".test.")
        || name.contains(".spec.")
        || name
            .rsplit_once('.')
            .is_some_and(|(stem, _)| stem.ends_with("_test"))
        || name.starts_with("test_") && name.ends_with(".py")
}

fn is_docs_path(path: &str) -> bool {
    let name = file_name(path).to_ascii_lowercase();
    path.starts_with("docs/")
        || path.contains("/docs/")
        || name.ends_with(".md")
        || name.ends_with(".mdx")
        || name.ends_with(".rst")
}

fn is_ci_path(path: &str) -> bool {
    path.starts_with(".github/")
        || path.starts_with(".circleci/")
        || file_name(path).starts_with(".gitlab-ci")
        || matches!(
            file_name(path),
            "Jenkinsfile" | "azure-pipelines.yml" | "bitbucket-pipelines.yml" | ".travis.yml"
        )
}

fn is_build_path(path: &str) -> bool {
    let name = file_name(path);
    matches!(
        name,
        "Cargo.toml"
            | "Cargo.lock"
            | "package.json"
            | "pnpm-lock.yaml"
            | "package-lock.json"
            | "yarn.lock"
            | "bun.lockb"
            | "pyproject.toml"
            | "poetry.lock"
            | "uv.lock"
            | "Pipfile"
            | "Pipfile.lock"
            | "go.mod"
            | "go.sum"
            | "Gemfile"
            | "Gemfile.lock"
            | "composer.json"
            | "composer.lock"
            | "pom.xml"
            | "build.gradle"
            | "build.gradle.kts"
            | "setup.py"
            | "mise.toml"
            | ".tool-versions"
    ) || (name.starts_with("requirements") && name.ends_with(".txt"))
}

/// File name without its extensions and test markers: `webhook.test.ts` gives `webhook`.
/// `index`, `mod`, `main` and `lib` give the parent directory instead.
pub fn path_name(path: &str) -> String {
    let name = file_name(path);
    let stem = if name.starts_with('.') {
        name.to_string()
    } else {
        name.split('.').next().unwrap_or(name).to_string()
    };
    let stem = stem
        .strip_suffix("_test")
        .or_else(|| stem.strip_prefix("test_"))
        .unwrap_or(&stem)
        .to_string();
    if matches!(stem.as_str(), "index" | "mod" | "main" | "lib" | "__init__") {
        let segs = segments(path);
        if segs.len() >= 2 {
            return segs[segs.len() - 2].to_string();
        }
    }
    stem
}

const GENERIC_DIRS: &[&str] = &[
    "src",
    "test",
    "tests",
    "__tests__",
    "docs",
    ".github",
    "scripts",
    "tools",
];

/// First directory under `src/`, else the top directory, unless it is a generic one.
fn dir_scope(path: &str) -> Option<String> {
    let segs = segments(path);
    let dirs = &segs[..segs.len().saturating_sub(1)];
    if let Some(i) = dirs.iter().position(|d| *d == "src")
        && i + 1 < dirs.len()
    {
        return Some(dirs[i + 1].to_string());
    }
    let first = dirs.first()?;
    if GENERIC_DIRS.contains(first) {
        return None;
    }
    Some((*first).to_string())
}

// ---------------------------------------------------------------------------
// Packages and scope
// ---------------------------------------------------------------------------

/// A package of the repo: its directory (empty for the root) and its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Package {
    pub dir: String,
    pub name: String,
}

/// Name of the package a manifest declares, from its file name and text.
pub fn manifest_name(file: &str, text: &str) -> Option<String> {
    match file_name(file) {
        "Cargo.toml" => toml::from_str::<toml::Value>(text)
            .ok()?
            .get("package")?
            .get("name")?
            .as_str()
            .map(str::to_string),
        "package.json" => serde_json::from_str::<serde_json::Value>(text)
            .ok()?
            .get("name")?
            .as_str()
            .map(str::to_string),
        "pyproject.toml" => {
            let v = toml::from_str::<toml::Value>(text).ok()?;
            v.get("project")
                .or_else(|| v.get("tool").and_then(|t| t.get("poetry")))?
                .get("name")?
                .as_str()
                .map(str::to_string)
        }
        _ => None,
    }
}

fn packages_of(dir: &Path) -> Vec<Package> {
    let listing = git(dir, &["ls-files", "-z", "--cached"]).unwrap_or_default();
    let mut out = Vec::new();
    for rel in listing.split('\0') {
        if !matches!(
            file_name(rel),
            "Cargo.toml" | "package.json" | "pyproject.toml"
        ) {
            continue;
        }
        if rel.contains("node_modules/") {
            continue;
        }
        let Ok(text) = fs::read_to_string(dir.join(rel)) else {
            continue;
        };
        if let Some(name) = manifest_name(rel, &text) {
            let pdir = rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
            if !out.iter().any(|p: &Package| p.dir == pdir) {
                out.push(Package {
                    dir: pdir.to_string(),
                    name,
                });
            }
        }
    }
    out
}

fn nearest_package<'a>(path: &str, pkgs: &'a [Package]) -> Option<&'a Package> {
    pkgs.iter()
        .filter(|p| p.dir.is_empty() || path.starts_with(&format!("{}/", p.dir)))
        .max_by_key(|p| p.dir.len())
}

fn common<I: IntoIterator<Item = Option<String>>>(items: I) -> Option<String> {
    let mut it = items.into_iter();
    let first = it.next()??;
    for x in it {
        if x.as_deref() != Some(first.as_str()) {
            return None;
        }
    }
    Some(first)
}

/// Scope of a set of paths: the package when the repo has several, else the
/// first directory under `src/` (or the top directory). `None` when ambiguous.
pub fn scope_for(paths: &[&str], pkgs: &[Package], tests: bool) -> Option<String> {
    if pkgs.len() >= 2 {
        return common(
            paths
                .iter()
                .map(|p| nearest_package(p, pkgs).map(|k| k.name.clone())),
        );
    }
    if tests {
        return common(paths.iter().map(|p| Some(path_name(p))));
    }
    common(paths.iter().map(|p| dir_scope(p)))
}

// ---------------------------------------------------------------------------
// Breaking changes
// ---------------------------------------------------------------------------

fn ident(s: &str) -> Option<&str> {
    let end = s
        .find(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
        .unwrap_or(s.len());
    (end > 0).then(|| &s[..end])
}

/// A public declaration on one line: its name and its signature text.
fn public_decl(line: &str) -> Option<(String, String)> {
    let t = line.trim_start();
    let sig = |s: &str| s.trim_end().trim_end_matches('{').trim_end().to_string();
    if let Some(mut rest) = t.strip_prefix("pub ") {
        for m in ["async ", "const ", "unsafe "] {
            if let Some(r) = rest.strip_prefix(m) {
                rest = r;
            }
        }
        for kw in ["fn ", "struct ", "enum ", "trait ", "type "] {
            if let Some(r) = rest.strip_prefix(kw) {
                return ident(r).map(|n| (n.to_string(), sig(t)));
            }
        }
        return None;
    }
    if let Some(mut rest) = t.strip_prefix("export ") {
        if let Some(r) = rest.strip_prefix("default ") {
            rest = r;
        }
        if let Some(r) = rest.strip_prefix("async ") {
            rest = r;
        }
        for kw in [
            "function* ",
            "function ",
            "class ",
            "interface ",
            "type ",
            "enum ",
        ] {
            if let Some(r) = rest.strip_prefix(kw) {
                return ident(r).map(|n| (n.to_string(), sig(t)));
            }
        }
        if let Some(r) = rest.strip_prefix("const ") {
            // A constant's value is not its signature.
            let head = t.split('=').next().unwrap_or(t);
            return ident(r).map(|n| (n.to_string(), sig(head)));
        }
    }
    None
}

fn is_config_path(path: &str) -> bool {
    let name = file_name(path);
    let lower = path.to_ascii_lowercase();
    name.starts_with(".env")
        || name.ends_with(".env")
        || name.starts_with("compose.")
        || name.starts_with("docker-compose")
        || (["yml", "yaml", "toml", "json", "ini"]
            .iter()
            .any(|e| name.ends_with(&format!(".{e}")))
            && lower.contains("config"))
}

fn env_var(line: &str) -> Option<String> {
    let t = line.trim().trim_start_matches("- ").trim();
    let t = t.strip_prefix("export ").unwrap_or(t);
    let t = t.trim_matches('"');
    let name = t.split(['=', ':']).next()?.trim();
    let after = &t[name.len()..];
    let ok = name.len() >= 3
        && name.starts_with(|c: char| c.is_ascii_uppercase())
        && name
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && (after.starts_with('=') || after.starts_with(':'));
    ok.then(|| name.to_string())
}

fn token_after(lower: &str, phrase: &str) -> Option<String> {
    let rest = lower.split(phrase).nth(1)?.trim_start();
    let rest = rest
        .strip_prefix("if exists")
        .map(str::trim_start)
        .unwrap_or(rest);
    let tok = rest
        .split(|c: char| c.is_whitespace() || c == ';' || c == ',')
        .next()?
        .trim_matches(|c| c == '"' || c == '`' || c == '\'');
    (!tok.is_empty()).then(|| tok.to_string())
}

fn sql_breaking(line: &str) -> Option<String> {
    let l = line.to_ascii_lowercase();
    if let Some(t) = token_after(&l, "drop table") {
        return Some(format!("migration drops table `{t}`"));
    }
    if let Some(c) = token_after(&l, "drop column") {
        return Some(format!("migration drops column `{c}`"));
    }
    if l.contains("rename column") {
        return Some("migration renames a column".to_string());
    }
    if l.contains("rename to") && l.contains("alter table") {
        return Some("migration renames a table".to_string());
    }
    if l.contains("alter column") && l.contains(" type ") {
        return Some("migration changes a column type".to_string());
    }
    if l.contains("drop_table") {
        return Some("migration drops a table".to_string());
    }
    if l.contains("remove_column") {
        return Some("migration drops a column".to_string());
    }
    None
}

/// Why this set of file changes breaks users, if it does. Heuristics, not proof:
/// - a removed or changed public declaration (`pub fn`, `export function`, ...),
/// - a deleted file that declared public items,
/// - a SQL migration dropping or renaming tables and columns,
/// - an environment variable removed or renamed in a config file.
pub fn breaking_reason(files: &[&ParsedFile]) -> Option<String> {
    let mut reasons: Vec<String> = Vec::new();
    for f in files {
        let lines: Vec<&DiffLine> = f.hunks.iter().flat_map(|h| h.hunk.lines.iter()).collect();
        let dels: Vec<&&DiffLine> = lines.iter().filter(|l| l.kind == LineKind::Del).collect();
        let adds: Vec<&&DiffLine> = lines.iter().filter(|l| l.kind == LineKind::Add).collect();
        let sql = f.path.ends_with(".sql") || f.path.ends_with(".rb");
        if sql && f.path.contains("migrat") {
            if let Some(r) = adds.iter().find_map(|l| sql_breaking(&l.text)) {
                reasons.push(r);
            }
            continue;
        }
        if is_config_path(&f.path) {
            let added: BTreeSet<String> = adds.iter().filter_map(|l| env_var(&l.text)).collect();
            let removed: Vec<String> = dels
                .iter()
                .filter_map(|l| env_var(&l.text))
                .filter(|v| !added.contains(v))
                .collect();
            if let Some(v) = removed.first() {
                reasons.push(format!("environment variable `{v}` renamed or removed"));
            }
            continue;
        }
        let new_decls: BTreeMap<String, String> =
            adds.iter().filter_map(|l| public_decl(&l.text)).collect();
        let old_decls: Vec<(String, String)> =
            dels.iter().filter_map(|l| public_decl(&l.text)).collect();
        if f.is_deleted {
            if !old_decls.is_empty() {
                reasons.push(format!("deleted public file {}", f.path));
            }
            continue;
        }
        for (name, old_sig) in old_decls {
            match new_decls.get(&name) {
                Some(new_sig) if *new_sig == old_sig => {}
                Some(_) => reasons.push(format!("`{name}` changed signature")),
                None => reasons.push(format!("`{name}` removed")),
            }
        }
    }
    reasons.dedup();
    reasons.truncate(3);
    (!reasons.is_empty()).then(|| reasons.join("; "))
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Bucket {
    Code,
    Refactor,
    Style,
    Test,
    Docs,
    Build,
    Ci,
}

fn squash(s: impl Iterator<Item = String>) -> String {
    s.flat_map(|l| l.chars().filter(|c| !c.is_whitespace()).collect::<Vec<_>>())
        .collect()
}

fn whitespace_only(f: &ParsedFile) -> bool {
    if f.hunks.is_empty() {
        return false;
    }
    let text = |kind: LineKind| {
        squash(
            f.hunks
                .iter()
                .flat_map(|h| h.hunk.lines.iter())
                .filter(|l| l.kind == kind)
                .map(|l| l.text.clone()),
        )
    };
    text(LineKind::Del) == text(LineKind::Add)
}

fn bucket(f: &ParsedFile) -> Bucket {
    let p = f.path.as_str();
    if is_ci_path(p) {
        Bucket::Ci
    } else if is_build_path(p) {
        Bucket::Build
    } else if is_test_path(p) {
        Bucket::Test
    } else if is_docs_path(p) {
        Bucket::Docs
    } else if f.from.is_some() && f.hunks.is_empty() {
        Bucket::Refactor
    } else if whitespace_only(f) {
        Bucket::Style
    } else {
        Bucket::Code
    }
}

/// Id used in a group for a staged file that has no hunks (a pure rename, a mode change).
pub fn file_marker(repo: &str, path: &str) -> String {
    format!("f:{}", hunk_id(repo, path, &[]))
}

fn join_names(names: &[String], fallback: &str) -> String {
    match names {
        [] => fallback.to_string(),
        [a] => a.clone(),
        [a, b] => format!("{a} and {b}"),
        _ => fallback.to_string(),
    }
}

fn distinct(paths: &[&ParsedFile]) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for f in paths {
        let n = path_name(&f.path);
        if !v.contains(&n) {
            v.push(n);
        }
    }
    v
}

/// Kind, subject, and scope paths for one bucket of files.
fn describe(b: Bucket, files: &[&ParsedFile], scope: Option<&str>) -> (CommitType, String) {
    match b {
        Bucket::Code => {
            let added: Vec<&ParsedFile> = files.iter().copied().filter(|f| f.is_new).collect();
            if !added.is_empty() {
                let names = distinct(&added);
                let subject = match names.as_slice() {
                    [one] => format!("add {one} module"),
                    [a, b] => format!("add {a} and {b}"),
                    _ => format!("add {}", scope.unwrap_or("new modules")),
                };
                return (CommitType::Feat, subject);
            }
            if files.iter().all(|f| f.is_deleted) {
                let names = distinct(files);
                return (
                    CommitType::Refactor,
                    format!(
                        "remove {}",
                        join_names(&names, scope.unwrap_or("unused code"))
                    ),
                );
            }
            let names = distinct(files);
            (
                CommitType::Fix,
                format!("update {}", join_names(&names, scope.unwrap_or("code"))),
            )
        }
        Bucket::Refactor => {
            let subject = match files {
                [f] => {
                    let from = f.from.as_deref().map(path_name).unwrap_or_default();
                    let to = path_name(&f.path);
                    if from == to {
                        format!("move {to}")
                    } else {
                        format!("rename {from} to {to}")
                    }
                }
                _ => "reorganize files".to_string(),
            };
            (CommitType::Refactor, subject)
        }
        Bucket::Style => (CommitType::Style, "format code".to_string()),
        Bucket::Test => {
            let names = distinct(files);
            (
                CommitType::Test,
                format!("cover {}", join_names(&names, scope.unwrap_or("changes"))),
            )
        }
        Bucket::Docs => (CommitType::Docs, "update docs".to_string()),
        Bucket::Build => (CommitType::Build, "update dependencies".to_string()),
        Bucket::Ci => (CommitType::Ci, "update ci".to_string()),
    }
}

/// `Refs: PAY-412, PAY-413` from the issue links of the space.
pub fn ticket_footer(links: &[Link]) -> Option<String> {
    let mut keys: Vec<&str> = Vec::new();
    for l in links.iter().filter(|l| l.kind == LinkKind::Issue) {
        if let Some(k) = l.key.as_deref()
            && !keys.contains(&k)
        {
            keys.push(k);
        }
    }
    (!keys.is_empty()).then(|| format!("Refs: {}", keys.join(", ")))
}

/// Propose commits for the staged hunks of the space.
pub fn plan(space: &Space, links: &[Link]) -> Result<CommitPlan> {
    let staged = staged_files(space)?;
    let footer = ticket_footer(links);
    let mut groups: Vec<CommitGroup> = Vec::new();
    let mut conventional = None;
    let mut rules = None;
    let mut n = 0;
    for r in &space.repos {
        let files: Vec<&ParsedFile> = staged.iter().filter(|f| f.repo == r.name).collect();
        if files.is_empty() {
            continue;
        }
        let (conv, rl) = detect_conventions(r);
        conventional = conventional.or(Some(conv));
        if rules.is_none() && (conv || rl != CommitRules::default()) {
            rules = Some(rl);
        }
        let pkgs = packages_of(Path::new(&r.worktree));
        let mut buckets: BTreeMap<Bucket, Vec<&ParsedFile>> = BTreeMap::new();
        for f in &files {
            buckets.entry(bucket(f)).or_default().push(f);
        }
        for (b, fs) in buckets {
            let paths: Vec<&str> = fs.iter().map(|f| f.path.as_str()).collect();
            let scope = match b {
                Bucket::Ci | Bucket::Docs if pkgs.len() < 2 => None,
                _ => scope_for(&paths, &pkgs, b == Bucket::Test),
            };
            let (kind, subject) = describe(b, &fs, scope.as_deref());
            let reason = matches!(b, Bucket::Code | Bucket::Refactor)
                .then(|| breaking_reason(&fs))
                .flatten();
            n += 1;
            groups.push(CommitGroup {
                id: format!("g{n}"),
                repo: r.name.clone(),
                kind,
                scope,
                breaking: reason.is_some(),
                breaking_reason: reason,
                subject,
                body: String::new(),
                footers: footer.iter().cloned().collect(),
                hunks: fs
                    .iter()
                    .flat_map(|f| {
                        if f.hunks.is_empty() {
                            vec![file_marker(&f.repo, &f.path)]
                        } else {
                            f.hunks.iter().map(|h| h.hunk.id.clone()).collect()
                        }
                    })
                    .collect(),
            });
        }
    }
    Ok(CommitPlan {
        conventional: conventional.unwrap_or(true),
        rules: rules.unwrap_or_default(),
        groups,
    })
}

// ---------------------------------------------------------------------------
// Committing
// ---------------------------------------------------------------------------

/// One commit made by [`commit_groups`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupCommit {
    pub group: String,
    pub repo: String,
    pub sha: String,
}

/// The index of a repo before we touched it, to put back on failure.
struct Saved {
    dir: std::path::PathBuf,
    head: String,
    tree: String,
}

fn restore(saved: &[Saved]) {
    for s in saved {
        let _ = git(&s.dir, &["reset", "-q", "--soft", &s.head]);
        let _ = git(&s.dir, &["read-tree", &s.tree]);
    }
}

/// Patch text for one group: file headers with only the hunks it takes, in file order.
fn patch_for(group: &CommitGroup, files: &[&ParsedFile]) -> Result<String> {
    let wanted: BTreeSet<&str> = group.hunks.iter().map(String::as_str).collect();
    let mut found: BTreeSet<&str> = BTreeSet::new();
    let mut patch = String::new();
    for f in files {
        if f.hunks.is_empty() {
            let marker = file_marker(&f.repo, &f.path);
            if let Some(m) = wanted.get(marker.as_str()) {
                found.insert(m);
                patch.push_str(&f.header);
            }
            continue;
        }
        let mut body = String::new();
        for h in &f.hunks {
            if let Some(id) = wanted.get(h.hunk.id.as_str()) {
                found.insert(id);
                body.push_str(&h.raw);
            }
        }
        if !body.is_empty() {
            patch.push_str(&f.header);
            patch.push_str(&body);
        }
    }
    if let Some(missing) = wanted.difference(&found).next() {
        return Err(Error::HunkNotFound((*missing).to_string()));
    }
    Ok(patch)
}

/// Commit each group in order.
///
/// For every group: reset the index of its repo to HEAD, stage exactly the
/// group's hunks (their ids are content hashes, so they stay valid), commit with
/// the composed message. Staged hunks no group takes are staged again at the
/// end. On any failure every commit made so far is undone and the index is put
/// back as it was.
pub fn commit_groups(
    space: &Space,
    conventional: bool,
    groups: &[CommitGroup],
) -> Result<Vec<GroupCommit>> {
    if groups.is_empty() {
        return Err(Error::NothingToCommit);
    }
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for g in groups {
        if g.subject.trim().is_empty() {
            return Err(Error::Invalid(format!("commit {} has no subject", g.id)));
        }
        if g.hunks.is_empty() {
            return Err(Error::Invalid(format!("commit {} has no hunks", g.id)));
        }
        if !space.repos.iter().any(|r| r.name == g.repo) {
            return Err(Error::RepoNotFound(g.repo.clone()));
        }
        for h in &g.hunks {
            if !seen.insert(h.as_str()) {
                return Err(Error::Invalid(format!("hunk {h} is in two commits")));
            }
        }
    }
    let staged = staged_files(space)?;
    // Build every patch before touching git.
    let mut patches: Vec<String> = Vec::new();
    for g in groups {
        let files: Vec<&ParsedFile> = staged.iter().filter(|f| f.repo == g.repo).collect();
        patches.push(patch_for(g, &files)?);
    }
    let mut saved: Vec<Saved> = Vec::new();
    let mut done: Vec<GroupCommit> = Vec::new();
    let result = (|| -> Result<()> {
        for (g, patch) in groups.iter().zip(&patches) {
            let r = space
                .repos
                .iter()
                .find(|r| r.name == g.repo)
                .ok_or_else(|| Error::RepoNotFound(g.repo.clone()))?;
            let dir = Path::new(&r.worktree);
            if !saved.iter().any(|s| s.dir == dir) {
                saved.push(Saved {
                    dir: dir.to_path_buf(),
                    head: git(dir, &["rev-parse", "HEAD"])?.trim().to_string(),
                    tree: git(dir, &["write-tree"])?.trim().to_string(),
                });
            }
            git(dir, &["read-tree", "HEAD"])?;
            if !patch.is_empty() {
                git_with(
                    dir,
                    &["apply", "--cached", "--whitespace=nowarn", "-"],
                    &[],
                    Some(patch),
                )
                .map_err(|e| match e {
                    Error::Git { stderr, .. } => Error::PatchFailed(stderr),
                    other => other,
                })?;
            }
            let message = compose_message(g, conventional);
            git_with(dir, &["commit", "-q", "-F", "-"], &[], Some(&message))?;
            done.push(GroupCommit {
                group: g.id.clone(),
                repo: g.repo.clone(),
                sha: git(dir, &["rev-parse", "HEAD"])?.trim().to_string(),
            });
        }
        // Put back the staged hunks no group took.
        for s in &saved {
            git(&s.dir, &["read-tree", &s.tree])?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(done),
        Err(e) => {
            restore(&saved);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::{ParsedHunk, hunk_id};
    use crate::model::{Hunk, HunkState, Origin};

    fn line(kind: LineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            text: text.to_string(),
            old: None,
            new: None,
        }
    }

    /// A parsed file with `-`/`+` lines in one hunk.
    fn file(path: &str, new: bool, deleted: bool, lines: &[(&str, &str)]) -> ParsedFile {
        let body: Vec<DiffLine> = lines
            .iter()
            .map(|(k, t)| {
                line(
                    match *k {
                        "+" => LineKind::Add,
                        "-" => LineKind::Del,
                        _ => LineKind::Context,
                    },
                    t,
                )
            })
            .collect();
        let hunks = if body.is_empty() {
            vec![]
        } else {
            vec![ParsedHunk {
                hunk: Hunk {
                    id: hunk_id("r", path, &body),
                    repo: "r".into(),
                    path: path.into(),
                    old_start: 1,
                    old_lines: 1,
                    new_start: 1,
                    new_lines: 1,
                    section: String::new(),
                    lines: body,
                    origin: Origin::You,
                    state: HunkState::Staged,
                },
                raw: String::new(),
                untracked: false,
            }]
        };
        ParsedFile {
            repo: "r".into(),
            path: path.into(),
            from: None,
            header: String::new(),
            is_new: new,
            is_deleted: deleted,
            hunks,
        }
    }

    fn group() -> CommitGroup {
        CommitGroup {
            id: "g1".into(),
            repo: "r".into(),
            kind: CommitType::Feat,
            scope: Some("billing".into()),
            breaking: false,
            breaking_reason: None,
            subject: "add refunds module".into(),
            body: String::new(),
            footers: vec![],
            hunks: vec!["h".into()],
        }
    }

    #[test]
    fn header_and_message() {
        let mut g = group();
        assert_eq!(header(&g, true), "feat(billing): add refunds module");
        assert_eq!(header(&g, false), "add refunds module");
        g.scope = None;
        assert_eq!(header(&g, true), "feat: add refunds module");
        g.scope = Some("  ".into());
        assert_eq!(header(&g, true), "feat: add refunds module");
        g.scope = Some("api".into());
        g.breaking = true;
        g.breaking_reason = Some("`pay` removed".into());
        g.body = "Longer text.".into();
        g.footers = vec!["Refs: PAY-1".into()];
        assert_eq!(
            compose_message(&g, true),
            "feat(api)!: add refunds module\n\nLonger text.\n\nBREAKING CHANGE: `pay` removed\nRefs: PAY-1"
        );
        // Outside conventional repos there is no BREAKING CHANGE footer.
        assert_eq!(
            compose_message(&g, false),
            "add refunds module\n\nLonger text.\n\nRefs: PAY-1"
        );
        g.breaking_reason = None;
        assert!(compose_message(&g, true).contains("BREAKING CHANGE: add refunds module"));
    }

    fn rules() -> CommitRules {
        CommitRules::default()
    }

    #[test]
    fn validate_accepts_good_headers() {
        assert!(validate("feat(billing)!: add refunds module", &rules()).is_empty());
        assert!(validate("fix: handle 400\n\nBody here.", &rules()).is_empty());
    }

    #[test]
    fn validate_finds_problems() {
        let f = |m: &str| {
            validate(m, &rules())
                .into_iter()
                .map(|p| p.field)
                .collect::<Vec<_>>()
        };
        assert_eq!(f("add refunds"), vec!["header"]);
        assert_eq!(f("feature: add"), vec!["type"]);
        assert_eq!(f("feat: "), vec!["subject"]);
        assert_eq!(f("feat: add."), vec!["subject"]);
        assert_eq!(f("feat(): add"), vec!["scope"]);
        assert_eq!(f("feat: add\nno blank line"), vec!["body"]);
        let long = format!("feat: {}", "x".repeat(80));
        assert_eq!(f(&long), vec!["header"]);
        assert_eq!(f(""), vec!["header"]);
    }

    #[test]
    fn validate_respects_rules() {
        let r = CommitRules {
            types: vec!["feat".into(), "fix".into()],
            scopes: vec!["api".into(), "web".into()],
            header_max: 20,
        };
        assert!(validate("feat(api): short", &r).is_empty());
        assert!(validate("feat(api,web): ok", &r).is_empty());
        let p = validate("chore(db): this header is long", &r);
        let fields: Vec<_> = p.iter().map(|p| p.field.as_str()).collect();
        assert_eq!(fields, vec!["type", "scope", "header"]);
        // No scope is fine even with a scope-enum.
        assert!(validate("fix: ok", &r).is_empty());
    }

    #[test]
    fn validate_plain_only_checks_basics() {
        assert!(validate_plain("Add refunds", &rules()).is_empty());
        assert_eq!(validate_plain("", &rules())[0].field, "subject");
        assert_eq!(validate_plain("Add.", &rules())[0].field, "subject");
        assert!(validate_for("Add refunds", &rules(), false).is_empty());
        assert!(!validate_for("Add refunds", &rules(), true).is_empty());
    }

    #[test]
    fn conventional_subjects() {
        for s in ["feat: x", "fix(api): y", "refactor!: z", "chore(a-b)!: w"] {
            assert!(is_conventional_subject(s), "{s}");
        }
        for s in [
            "Merge branch main",
            "Feat: x",
            "feat:x",
            "feat(): x",
            "wip",
            ": x",
        ] {
            assert!(!is_conventional_subject(s), "{s}");
        }
    }

    #[test]
    fn commitlint_json() {
        let r = parse_commitlint(
            r#"{"extends":["@commitlint/config-conventional"],"rules":{
                "type-enum":[2,"always",["feat","fix","deps"]],
                "scope-enum":[2,"always",["api","web"]],
                "header-max-length":[2,"always",100]}}"#,
        );
        assert_eq!(r.types, vec!["feat", "fix", "deps"]);
        assert_eq!(r.scopes, vec!["api", "web"]);
        assert_eq!(r.header_max, 100);
        let off = parse_commitlint(r#"{"rules":{"type-enum":[0,"always",["x"]]}}"#);
        assert_eq!(off, CommitRules::default());
        assert_eq!(parse_commitlint("not json"), CommitRules::default());
    }

    #[test]
    fn path_rules() {
        for p in [
            "tests/a.rs",
            "src/__tests__/a.ts",
            "src/a.test.ts",
            "src/a.spec.js",
            "pkg/a_test.go",
            "test/x/y.rs",
            "tests_helper/test_a.py",
        ] {
            assert!(is_test_path(p), "{p}");
        }
        for p in ["src/latest.rs", "src/contest/a.rs", "src/testing.rs"] {
            assert!(!is_test_path(p), "{p}");
        }
        assert!(is_docs_path("README.md") && is_docs_path("docs/a.txt"));
        assert!(is_ci_path(".github/workflows/ci.yml") && is_ci_path(".gitlab-ci.yml"));
        assert!(is_build_path("Cargo.lock") && is_build_path("web/package.json"));
        assert!(is_build_path("requirements-dev.txt"));
        assert!(!is_build_path("src/package.rs"));
    }

    #[test]
    fn names() {
        assert_eq!(path_name("src/billing/webhook.ts"), "webhook");
        assert_eq!(path_name("src/billing/webhook.test.ts"), "webhook");
        assert_eq!(path_name("pkg/webhook_test.go"), "webhook");
        assert_eq!(path_name("src/billing/index.ts"), "billing");
        assert_eq!(path_name("src/lib.rs"), "src");
        assert_eq!(path_name("main.rs"), "main");
        assert_eq!(path_name(".env.example"), ".env.example");
    }

    #[test]
    fn scope_from_directories() {
        let none: Vec<Package> = vec![];
        assert_eq!(
            scope_for(&["src/billing/a.ts", "src/billing/b.ts"], &none, false).as_deref(),
            Some("billing")
        );
        assert_eq!(
            scope_for(&["src/billing/a.ts", "src/auth/b.ts"], &none, false),
            None
        );
        assert_eq!(
            scope_for(&["lib/stripe.ts"], &none, false).as_deref(),
            Some("lib")
        );
        assert_eq!(scope_for(&["src/main.rs"], &none, false), None);
        assert_eq!(scope_for(&["README.md"], &none, false), None);
        assert_eq!(
            scope_for(&["app/src/billing/a.ts"], &none, false).as_deref(),
            Some("billing")
        );
        assert_eq!(
            scope_for(&["tests/webhook.test.ts"], &none, true).as_deref(),
            Some("webhook")
        );
        assert_eq!(scope_for(&["tests/a.rs", "tests/b.rs"], &none, true), None);
    }

    #[test]
    fn scope_from_packages() {
        let pkgs = vec![
            Package {
                dir: "crates/core".into(),
                name: "core".into(),
            },
            Package {
                dir: "crates/cli".into(),
                name: "cli".into(),
            },
        ];
        assert_eq!(
            scope_for(
                &["crates/core/src/a.rs", "crates/core/src/b/c.rs"],
                &pkgs,
                false
            )
            .as_deref(),
            Some("core")
        );
        assert_eq!(
            scope_for(
                &["crates/core/src/a.rs", "crates/cli/src/b.rs"],
                &pkgs,
                false
            ),
            None
        );
        assert_eq!(scope_for(&["README.md"], &pkgs, false), None);
        let nested = vec![
            Package {
                dir: String::new(),
                name: "root".into(),
            },
            Package {
                dir: "web".into(),
                name: "web-app".into(),
            },
        ];
        assert_eq!(
            scope_for(&["web/src/a.ts"], &nested, false).as_deref(),
            Some("web-app")
        );
        assert_eq!(
            scope_for(&["src/a.ts"], &nested, false).as_deref(),
            Some("root")
        );
        assert_eq!(
            scope_for(&["web/src/a.test.ts"], &nested, true).as_deref(),
            Some("web-app")
        );
    }

    #[test]
    fn manifests() {
        assert_eq!(
            manifest_name("Cargo.toml", "[package]\nname = \"vela-core\"\n").as_deref(),
            Some("vela-core")
        );
        assert_eq!(
            manifest_name("Cargo.toml", "[workspace]\nmembers = []\n"),
            None
        );
        assert_eq!(
            manifest_name("web/package.json", "{\"name\":\"@acme/web\"}").as_deref(),
            Some("@acme/web")
        );
        assert_eq!(
            manifest_name("pyproject.toml", "[project]\nname = \"svc\"\n").as_deref(),
            Some("svc")
        );
        assert_eq!(
            manifest_name("pyproject.toml", "[tool.poetry]\nname = \"svc2\"\n").as_deref(),
            Some("svc2")
        );
        assert_eq!(manifest_name("go.mod", "module x"), None);
    }

    #[test]
    fn breaking_public_api() {
        let removed = file(
            "src/lib.rs",
            false,
            false,
            &[
                ("-", "pub fn charge(amount: u32) {"),
                ("+", "fn charge(amount: u32) {"),
            ],
        );
        assert_eq!(
            breaking_reason(&[&removed]).as_deref(),
            Some("`charge` removed")
        );
        let changed = file(
            "src/lib.rs",
            false,
            false,
            &[
                ("-", "pub fn charge(a: u32) -> u32 {"),
                ("+", "pub fn charge(a: u32, b: u32) -> u32 {"),
            ],
        );
        assert_eq!(
            breaking_reason(&[&changed]).as_deref(),
            Some("`charge` changed signature")
        );
        let ts = file(
            "src/a.ts",
            false,
            false,
            &[
                ("-", "export function pay(a: number) {"),
                ("+", "export function pay(a: string) {"),
            ],
        );
        assert_eq!(
            breaking_reason(&[&ts]).as_deref(),
            Some("`pay` changed signature")
        );
        let class = file(
            "src/a.ts",
            false,
            false,
            &[("-", "export default class Pay {"), ("+", "class Pay {")],
        );
        assert!(breaking_reason(&[&class]).is_some());
        let st = file(
            "src/a.rs",
            false,
            false,
            &[
                ("-", "pub struct Config {"),
                ("+", "pub struct Config<T> {"),
            ],
        );
        assert!(breaking_reason(&[&st]).is_some());
    }

    #[test]
    fn not_breaking() {
        let added = file("src/lib.rs", false, false, &[("+", "pub fn refund() {")]);
        assert_eq!(breaking_reason(&[&added]), None);
        let private = file(
            "src/lib.rs",
            false,
            false,
            &[("-", "pub(crate) fn x() {"), ("+", "fn x() {")],
        );
        assert_eq!(breaking_reason(&[&private]), None);
        let body = file(
            "src/lib.rs",
            false,
            false,
            &[("-", "    let a = 1;"), ("+", "    let a = 2;")],
        );
        assert_eq!(breaking_reason(&[&body]), None);
        // A constant whose value changes keeps its signature.
        let c = file(
            "src/a.ts",
            false,
            false,
            &[
                ("-", "export const LIMIT = 10"),
                ("+", "export const LIMIT = 20"),
            ],
        );
        assert_eq!(breaking_reason(&[&c]), None);
    }

    #[test]
    fn breaking_deleted_file() {
        let d = file(
            "src/old.ts",
            false,
            true,
            &[("-", "export function legacy() {"), ("-", "}")],
        );
        assert_eq!(
            breaking_reason(&[&d]).as_deref(),
            Some("deleted public file src/old.ts")
        );
        let private = file("src/old.ts", false, true, &[("-", "function legacy() {")]);
        assert_eq!(breaking_reason(&[&private]), None);
    }

    #[test]
    fn breaking_migrations() {
        let m = file(
            "db/migrations/002.sql",
            true,
            false,
            &[("+", "ALTER TABLE users DROP COLUMN email;")],
        );
        assert_eq!(
            breaking_reason(&[&m]).as_deref(),
            Some("migration drops column `email`")
        );
        let t = file(
            "migrations/003.sql",
            true,
            false,
            &[("+", "drop table if exists \"orders\";")],
        );
        assert_eq!(
            breaking_reason(&[&t]).as_deref(),
            Some("migration drops table `orders`")
        );
        let ok = file(
            "migrations/004.sql",
            true,
            false,
            &[("+", "ALTER TABLE users ADD COLUMN age int;")],
        );
        assert_eq!(breaking_reason(&[&ok]), None);
        let elsewhere = file("scripts/x.sql", true, false, &[("+", "drop table t;")]);
        assert_eq!(breaking_reason(&[&elsewhere]), None);
        let rails = file(
            "db/migrate/1_x.rb",
            true,
            false,
            &[("+", "    remove_column :users, :email")],
        );
        assert!(breaking_reason(&[&rails]).is_some());
    }

    #[test]
    fn breaking_env_names() {
        let e = file(
            ".env.example",
            false,
            false,
            &[("-", "STRIPE_KEY=abc"), ("+", "STRIPE_SECRET_KEY=abc")],
        );
        assert_eq!(
            breaking_reason(&[&e]).as_deref(),
            Some("environment variable `STRIPE_KEY` renamed or removed")
        );
        let same = file(
            ".env.example",
            false,
            false,
            &[("-", "STRIPE_KEY=abc"), ("+", "STRIPE_KEY=def")],
        );
        assert_eq!(breaking_reason(&[&same]), None);
        let compose = file(
            "compose.yml",
            false,
            false,
            &[
                ("-", "      - DATABASE_URL=postgres://a"),
                ("+", "      - DB_URL=postgres://a"),
            ],
        );
        assert!(breaking_reason(&[&compose]).is_some());
        let not_config = file("src/a.ts", false, false, &[("-", "STRIPE_KEY=abc")]);
        assert_eq!(breaking_reason(&[&not_config]), None);
    }

    #[test]
    fn whitespace_detection() {
        let ws = file(
            "src/a.ts",
            false,
            false,
            &[("-", "a  =  1"), ("+", "a = 1")],
        );
        assert_eq!(bucket(&ws), Bucket::Style);
        let real = file("src/a.ts", false, false, &[("-", "a = 1"), ("+", "a = 2")]);
        assert_eq!(bucket(&real), Bucket::Code);
        let mut renamed = file("src/b.ts", false, false, &[]);
        renamed.from = Some("src/a.ts".into());
        assert_eq!(bucket(&renamed), Bucket::Refactor);
    }

    #[test]
    fn ticket_footers() {
        use crate::links::{IssueConfig, make_link};
        use crate::model::LinkSource;
        let cfg = IssueConfig::default();
        let links = vec![
            cfg.key_link("PAY-1", LinkSource::Branch),
            cfg.key_link("PAY-2", LinkSource::Commit),
            cfg.key_link("PAY-1", LinkSource::Commit),
            make_link("https://staging.x.dev", None, LinkSource::Manual),
        ];
        assert_eq!(ticket_footer(&links).as_deref(), Some("Refs: PAY-1, PAY-2"));
        assert_eq!(ticket_footer(&links[3..]), None);
    }
}
