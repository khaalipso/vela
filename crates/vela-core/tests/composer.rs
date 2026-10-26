//! Links and commit composer on real temporary git repos.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use vela_core::Vela;
use vela_core::commitplan::{self, commit_groups, plan};
use vela_core::links::{self, IssueConfig};
use vela_core::model::*;
use vela_core::{diff, space};

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn write(dir: &Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

fn repo(root: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    sh(&dir, &["init", "-q", "-b", "main"]);
    sh(&dir, &["config", "user.name", "Test"]);
    sh(&dir, &["config", "user.email", "test@example.com"]);
    sh(&dir, &["config", "commit.gpgsign", "false"]);
    for (p, c) in files {
        write(&dir, p, c);
    }
    sh(&dir, &["add", "-A"]);
    sh(&dir, &["commit", "-q", "-m", "init"]);
    dir
}

struct Env {
    _tmp: TempDir,
    root: PathBuf,
    vela: Vela,
}

fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let vela = Vela::new(root.join("home"));
    Env {
        _tmp: tmp,
        root,
        vela,
    }
}

fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

fn wt(s: &Space) -> PathBuf {
    PathBuf::from(&s.repos[0].worktree)
}

fn space_with(e: &Env, files: &[(&str, &str)]) -> Space {
    let r = repo(&e.root, "api", files);
    space::create(&e.vela, "Task", &[r], None).unwrap()
}

fn staged_names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = sh(dir, &["diff", "--cached", "--name-only"])
        .lines()
        .map(str::to_string)
        .collect();
    v.sort();
    v
}

fn show_names(dir: &Path, rev: &str) -> Vec<String> {
    let mut v: Vec<String> = sh(dir, &["show", "--name-only", "--format=", rev])
        .lines()
        .map(str::to_string)
        .collect();
    v.sort();
    v
}

const WEBHOOK: &str = "export function handle(req) {\n  return 1\n}\n";

fn base_files() -> Vec<(&'static str, &'static str)> {
    vec![
        ("src/billing/webhook.ts", WEBHOOK),
        ("README.md", "# api\n"),
        ("src/main.ts", "start()\n"),
    ]
}

/// Stage a feature, a test and a doc change.
fn stage_three(s: &Space) {
    let d = wt(s);
    write(&d, "src/billing/refunds.ts", "export const refund = 1\n");
    write(
        &d,
        "src/billing/webhook.ts",
        "export function handle(req) {\n  return 2\n}\n",
    );
    write(&d, "tests/webhook.test.ts", "test('x', () => {})\n");
    write(&d, "README.md", "# api\n\nRefunds.\n");
    sh(&d, &["add", "-A"]);
}

#[test]
fn plan_splits_feature_test_and_docs() {
    let e = env();
    let s = space_with(&e, &base_files());
    stage_three(&s);
    let p = plan(&s, &[]).unwrap();
    let kinds: Vec<CommitType> = p.groups.iter().map(|g| g.kind).collect();
    assert_eq!(
        kinds,
        vec![CommitType::Feat, CommitType::Test, CommitType::Docs]
    );
    let feat = &p.groups[0];
    assert_eq!(feat.scope.as_deref(), Some("billing"));
    assert_eq!(feat.subject, "add refunds module");
    assert!(!feat.breaking);
    assert_eq!(feat.hunks.len(), 2);
    let test = &p.groups[1];
    assert_eq!(test.scope.as_deref(), Some("webhook"));
    assert_eq!(test.subject, "cover webhook");
    let docs = &p.groups[2];
    assert_eq!(docs.scope, None);
    assert_eq!(docs.subject, "update docs");
    assert_eq!(
        p.groups.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
        ["g1", "g2", "g3"]
    );
    // Every staged hunk belongs to exactly one group.
    let all: Vec<String> = p.groups.iter().flat_map(|g| g.hunks.clone()).collect();
    let staged: Vec<String> = diff::staged_hunks(&s)
        .unwrap()
        .into_iter()
        .map(|h| h.id)
        .collect();
    let mut a = all.clone();
    let mut b = staged.clone();
    a.sort();
    b.sort();
    assert_eq!(a, b);
    // No history yet: a fresh repo with one non conventional commit.
    assert!(!p.conventional);
}

#[test]
fn plan_marks_fix_footers_and_breaking() {
    let e = env();
    let s = space_with(
        &e,
        &[(
            "src/pay/api.rs",
            "pub fn charge(a: u32) -> u32 {\n    a\n}\n",
        )],
    );
    let d = wt(&s);
    write(
        &d,
        "src/pay/api.rs",
        "pub fn charge(a: u32, b: u32) -> u32 {\n    a + b\n}\n",
    );
    sh(&d, &["add", "-A"]);
    let cfg = IssueConfig::default();
    let mut s2 = s.clone();
    s2.branch = "feat/PAY-412-refunds".into();
    let l = links::list_links(&s2, &cfg).unwrap();
    let p = plan(&s2, &l).unwrap();
    assert_eq!(p.groups.len(), 1);
    let g = &p.groups[0];
    assert_eq!(g.kind, CommitType::Fix);
    assert_eq!(g.scope.as_deref(), Some("pay"));
    assert_eq!(g.subject, "update api");
    assert!(g.breaking);
    assert_eq!(
        g.breaking_reason.as_deref(),
        Some("`charge` changed signature")
    );
    assert_eq!(g.footers, vec!["Refs: PAY-412"]);
}

#[test]
fn plan_detects_renames_style_build_and_ci() {
    let e = env();
    let s = space_with(
        &e,
        &[
            ("src/old_name.ts", &numbered(20)),
            ("src/fmt.ts", "const a  =  1\n"),
            ("Cargo.lock", "a\n"),
            (".github/workflows/ci.yml", "on: push\n"),
        ],
    );
    let d = wt(&s);
    sh(&d, &["mv", "src/old_name.ts", "src/new_name.ts"]);
    write(&d, "src/fmt.ts", "const a = 1\n");
    write(&d, "Cargo.lock", "b\n");
    write(&d, ".github/workflows/ci.yml", "on: [push]\n");
    sh(&d, &["add", "-A"]);
    let p = plan(&s, &[]).unwrap();
    let kinds: Vec<CommitType> = p.groups.iter().map(|g| g.kind).collect();
    assert_eq!(
        kinds,
        vec![
            CommitType::Refactor,
            CommitType::Style,
            CommitType::Build,
            CommitType::Ci
        ]
    );
    assert_eq!(p.groups[0].subject, "rename old_name to new_name");
    // The pure rename has no hunk: it travels as a file marker and still commits.
    assert!(p.groups[0].hunks[0].starts_with("f:"));
    let done = commit_groups(&s, p.conventional, &p.groups).unwrap();
    assert_eq!(done.len(), 4);
    assert!(staged_names(&d).is_empty());
    let status = sh(&d, &["show", "--name-status", "--format=", "HEAD~3"]);
    assert!(
        status.starts_with("R100\tsrc/old_name.ts\tsrc/new_name.ts"),
        "{status}"
    );
}

#[test]
fn plan_scope_uses_package_names_when_there_are_several() {
    let e = env();
    let s = space_with(
        &e,
        &[
            (
                "crates/core/Cargo.toml",
                "[package]\nname = \"core-lib\"\nversion = \"0.1.0\"\n",
            ),
            (
                "crates/cli/Cargo.toml",
                "[package]\nname = \"cli\"\nversion = \"0.1.0\"\n",
            ),
            ("crates/core/src/lib.rs", "fn a() {}\n"),
            ("crates/cli/src/main.rs", "fn main() {}\n"),
        ],
    );
    let d = wt(&s);
    write(&d, "crates/core/src/lib.rs", "fn a() { 1; }\n");
    sh(&d, &["add", "-A"]);
    let p = plan(&s, &[]).unwrap();
    assert_eq!(p.groups[0].scope.as_deref(), Some("core-lib"));
    write(&d, "crates/cli/src/main.rs", "fn main() { 1; }\n");
    sh(&d, &["add", "-A"]);
    let p = plan(&s, &[]).unwrap();
    assert_eq!(p.groups.len(), 1);
    assert_eq!(
        p.groups[0].scope, None,
        "two packages in one group is ambiguous"
    );
}

#[test]
fn conventions_from_history_and_commitlint() {
    let e = env();
    let r = repo(&e.root, "conv", &[("a.txt", "a\n")]);
    for (i, m) in ["feat: one", "fix(api): two", "chore: three", "wip stuff"]
        .iter()
        .enumerate()
    {
        write(&r, "a.txt", &format!("{i}\n"));
        sh(&r, &["commit", "-q", "-am", m]);
    }
    let sp = space::create(&e.vela, "Conv", &[&r], None).unwrap();
    let (conv, rules) = commitplan::detect_conventions(&sp.repos[0]);
    // 3 of 5 subjects (init counts) is exactly 60%.
    assert!(conv);
    assert_eq!(rules, CommitRules::default());

    let r2 = repo(&e.root, "plain", &[("a.txt", "a\n")]);
    sh(
        &r2,
        &["commit", "-q", "--allow-empty", "-m", "Update things"],
    );
    let sp2 = space::create(&e.vela, "Plain", &[&r2], None).unwrap();
    assert!(!commitplan::detect_conventions(&sp2.repos[0]).0);

    let r3 = repo(
        &e.root,
        "lint",
        &[(
            ".commitlintrc.json",
            r#"{"rules":{"type-enum":[2,"always",["feat","fix"]],"scope-enum":[2,"always",["ui"]],"header-max-length":[2,"always",50]}}"#,
        )],
    );
    let sp3 = space::create(&e.vela, "Lint", &[&r3], None).unwrap();
    let (conv, rules) = commitplan::detect_conventions(&sp3.repos[0]);
    assert!(conv);
    assert_eq!(rules.types, vec!["feat", "fix"]);
    assert_eq!(rules.scopes, vec!["ui"]);
    assert_eq!(rules.header_max, 50);
}

#[test]
fn three_groups_make_three_commits() {
    let e = env();
    let s = space_with(&e, &base_files());
    let d = wt(&s);
    stage_three(&s);
    let head0 = sh(&d, &["rev-parse", "HEAD"]).trim().to_string();
    // An unstaged edit must survive untouched.
    write(&d, "src/main.ts", "start(1)\n");
    let p = plan(&s, &[]).unwrap();
    let mut groups = p.groups.clone();
    groups[0].body = "Adds the refunds module.".into();
    groups[0].footers = vec!["Refs: PAY-1".into()];
    groups[2].breaking = true;
    groups[2].breaking_reason = Some("docs moved".into());
    let done = commit_groups(&s, true, &groups).unwrap();
    assert_eq!(done.len(), 3);
    assert_eq!(
        done.iter().map(|c| c.group.as_str()).collect::<Vec<_>>(),
        ["g1", "g2", "g3"]
    );
    assert_eq!(
        sh(&d, &["rev-list", "--count", &format!("{head0}..HEAD")]).trim(),
        "3"
    );
    assert_eq!(
        show_names(&d, "HEAD~2"),
        vec!["src/billing/refunds.ts", "src/billing/webhook.ts"]
    );
    assert_eq!(show_names(&d, "HEAD~1"), vec!["tests/webhook.test.ts"]);
    assert_eq!(show_names(&d, "HEAD"), vec!["README.md"]);
    assert_eq!(
        sh(&d, &["log", "-1", "--format=%B", "HEAD~2"]).trim(),
        "feat(billing): add refunds module\n\nAdds the refunds module.\n\nRefs: PAY-1"
    );
    assert_eq!(
        sh(&d, &["log", "-1", "--format=%B", "HEAD"]).trim(),
        "docs!: update docs\n\nBREAKING CHANGE: docs moved"
    );
    assert!(staged_names(&d).is_empty());
    assert_eq!(
        fs::read_to_string(d.join("src/main.ts")).unwrap(),
        "start(1)\n"
    );
    assert_eq!(sh(&d, &["diff", "--name-only"]).trim(), "src/main.ts");
}

#[test]
fn hunks_of_one_file_split_across_commits() {
    let e = env();
    let s = space_with(&e, &[("src/big.ts", &numbered(40))]);
    let d = wt(&s);
    let mut text = numbered(40);
    text = text
        .replace("line 2\n", "line two\n")
        .replace("line 38\n", "line thirty-eight\n");
    write(&d, "src/big.ts", &text);
    sh(&d, &["add", "-A"]);
    let hunks = diff::staged_hunks(&s).unwrap();
    assert_eq!(hunks.len(), 2);
    let mk = |id: &str, h: &Hunk, subject: &str| CommitGroup {
        id: id.into(),
        repo: h.repo.clone(),
        kind: CommitType::Fix,
        scope: None,
        breaking: false,
        breaking_reason: None,
        subject: subject.into(),
        body: String::new(),
        footers: vec![],
        hunks: vec![h.id.clone()],
    };
    // Second hunk first: order of groups is the order of commits.
    let groups = vec![mk("a", &hunks[1], "late"), mk("b", &hunks[0], "early")];
    commit_groups(&s, false, &groups).unwrap();
    assert_eq!(
        sh(&d, &["log", "--format=%s", "-2"])
            .lines()
            .collect::<Vec<_>>(),
        ["early", "late"]
    );
    assert_eq!(fs::read_to_string(d.join("src/big.ts")).unwrap(), text);
    assert!(sh(&d, &["status", "--porcelain"]).trim().is_empty());
}

#[test]
fn hunks_no_group_takes_stay_staged() {
    let e = env();
    let s = space_with(&e, &base_files());
    let d = wt(&s);
    stage_three(&s);
    let p = plan(&s, &[]).unwrap();
    // Commit only the test group.
    let only = vec![p.groups[1].clone()];
    commit_groups(&s, true, &only).unwrap();
    assert_eq!(show_names(&d, "HEAD"), vec!["tests/webhook.test.ts"]);
    assert_eq!(
        staged_names(&d),
        vec![
            "README.md",
            "src/billing/refunds.ts",
            "src/billing/webhook.ts"
        ]
    );
}

#[test]
fn failure_restores_index_and_history() {
    let e = env();
    let s = space_with(&e, &base_files());
    let d = wt(&s);
    stage_three(&s);
    let p = plan(&s, &[]).unwrap();
    let before_names = staged_names(&d);
    let before_tree = sh(&d, &["write-tree"]);
    let head0 = sh(&d, &["rev-parse", "HEAD"]);
    // A hook that lets the first commit through and refuses the second.
    let hooks = d.join(".git-hooks-test");
    fs::create_dir_all(&hooks).unwrap();
    let hook = hooks.join("commit-msg");
    fs::write(
        &hook,
        "#!/bin/sh\ncase \"$(head -n1 \"$1\")\" in test*) echo refused >&2; exit 1;; esac\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    sh(&d, &["config", "core.hooksPath", hooks.to_str().unwrap()]);
    let err = commit_groups(&s, true, &p.groups).unwrap_err();
    assert!(err.to_string().contains("commit"), "{err}");
    assert_eq!(
        sh(&d, &["rev-parse", "HEAD"]),
        head0,
        "first commit rolled back"
    );
    assert_eq!(sh(&d, &["write-tree"]), before_tree);
    assert_eq!(staged_names(&d), before_names);
    // The worktree files are intact.
    assert!(d.join("tests/webhook.test.ts").exists());
}

#[test]
fn bad_input_changes_nothing() {
    let e = env();
    let s = space_with(&e, &base_files());
    let d = wt(&s);
    stage_three(&s);
    let p = plan(&s, &[]).unwrap();
    let before = sh(&d, &["write-tree"]);
    let mut empty = p.groups.clone();
    empty[1].subject = "  ".into();
    assert!(matches!(
        commit_groups(&s, true, &empty),
        Err(vela_core::Error::Invalid(_))
    ));
    let mut unknown = p.groups.clone();
    unknown[2].hunks = vec!["deadbeef".into()];
    assert!(matches!(
        commit_groups(&s, true, &unknown),
        Err(vela_core::Error::HunkNotFound(_))
    ));
    let mut twice = p.groups.clone();
    twice[1].hunks = twice[0].hunks.clone();
    assert!(commit_groups(&s, true, &twice).is_err());
    assert!(matches!(
        commit_groups(&s, true, &[]),
        Err(vela_core::Error::NothingToCommit)
    ));
    assert_eq!(sh(&d, &["write-tree"]), before);
}

#[test]
fn links_from_branch_commits_origin_and_repo_file() {
    let e = env();
    let r = repo(
        &e.root,
        "api",
        &[(
            ".vela/links.toml",
            "[[links]]\nurl = \"https://grafana.acme.io/d/x/api-latency\"\ntitle = \"API latency\"\n",
        )],
    );
    sh(
        &r,
        &["remote", "add", "origin", "git@github.com:acme/api.git"],
    );
    let mut s = space::create(&e.vela, "Refunds", &[&r], None).unwrap();
    s.branch = "feat/PAY-412-refunds".into();
    let d = wt(&s);
    write(&d, "a.txt", "a\n");
    sh(&d, &["add", "-A"]);
    sh(
        &d,
        &["commit", "-q", "-m", "feat: refunds, fixes #12 and ENG-9"],
    );
    let cfg = IssueConfig::parse("[issues]\njira = \"https://acme.atlassian.net/browse/{key}\"");
    let l = links::list_links(&s, &cfg).unwrap();
    let titles: Vec<&str> = l.iter().map(|x| x.title.as_str()).collect();
    assert_eq!(
        titles,
        vec!["PAY-412", "ENG-9", "acme/api#12", "API latency"]
    );
    assert_eq!(l[0].source, LinkSource::Branch);
    assert_eq!(l[0].url, "https://acme.atlassian.net/browse/PAY-412");
    assert_eq!(l[1].source, LinkSource::Commit);
    assert_eq!(l[2].url, "https://github.com/acme/api/issues/12");
    assert_eq!(l[3].source, LinkSource::Repo);
    assert_eq!(l[3].kind, LinkKind::Dashboard);

    // Stored links win over detected ones and are deduped by url.
    let stored = links::add_link(
        &mut s,
        "https://acme.atlassian.net/browse/PAY-412",
        Some("Refund ticket"),
    )
    .unwrap();
    let l = links::list_links(&s, &cfg).unwrap();
    assert_eq!(l.len(), 4);
    assert_eq!(l[0].id, stored.id);
    assert_eq!(l[0].title, "Refund ticket");
}

#[test]
fn hash_refs_need_a_github_origin_and_keys_need_no_config() {
    let e = env();
    let r = repo(&e.root, "api", &[("a.txt", "a\n")]);
    sh(
        &r,
        &["remote", "add", "origin", "git@gitlab.com:acme/api.git"],
    );
    let mut s = space::create(&e.vela, "Refunds", &[&r], None).unwrap();
    s.branch = "feat/PAY-5".into();
    let d = wt(&s);
    write(&d, "a.txt", "b\n");
    sh(&d, &["commit", "-q", "-am", "fix #99"]);
    let l = links::list_links(&s, &IssueConfig::default()).unwrap();
    assert_eq!(l.len(), 1);
    assert_eq!(l[0].key.as_deref(), Some("PAY-5"));
    assert_eq!(l[0].url, "");
    assert!(l[0].title.contains("no tracker URL"));
}

#[test]
fn links_survive_the_store() {
    let e = env();
    let r = repo(&e.root, "api", &[("a.txt", "a\n")]);
    let mut s = space::create(&e.vela, "Refunds", &[&r], None).unwrap();
    links::add_link(&mut s, "https://linear.app/a/issue/ENG-1/x", None).unwrap();
    vela_core::store::save(&e.vela, &s).unwrap();
    let back = vela_core::store::load(&e.vela, &s.id).unwrap();
    assert_eq!(back.links, s.links);
    // A space file written before links existed still loads.
    let text = fs::read_to_string(vela_core::paths::space_file(&e.vela.home, &s.id)).unwrap();
    let old: String = text.split("\n[[links]]").next().unwrap().to_string();
    fs::write(vela_core::paths::space_file(&e.vela.home, &s.id), old).unwrap();
    assert!(
        vela_core::store::load(&e.vela, &s.id)
            .unwrap()
            .links
            .is_empty()
    );
}
