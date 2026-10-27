//! Command layer tests on temporary git repos. No webview.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use vela_app::commands::{self, FileRef};
use vela_app::watch::{self, ChangeKind, Root};
use vela_core::Vela;
use vela_core::model::{HunkState, Origin, Space, UpNext};

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

const BODY: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\nthirteen\nfourteen\nfifteen\nsixteen\nseventeen\neighteen\nnineteen\ntwenty\n";

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

/// A space "Fix it" on one repo "api" with a 20 line file.
fn space(e: &Env) -> Space {
    let api = repo(&e.root, "api", &[("a.txt", BODY), ("src/b.txt", "b\n")]);
    commands::create_space(
        &e.vela,
        "Fix it",
        &[api.to_string_lossy().into_owned()],
        None,
        None,
    )
    .unwrap()
}

fn wt(s: &Space) -> PathBuf {
    PathBuf::from(&s.repos[0].worktree)
}

#[test]
fn creates_and_lists_spaces() {
    let e = env();
    let s = space(&e);
    assert_eq!(s.id, "fix-it");
    assert_eq!(s.branch, "feat/fix-it");
    assert_eq!(s.repos[0].name, "api");
    let list = commands::list_spaces(&e.vela).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, "fix-it");
    // Same name again, and an unknown repo, come back as typed errors.
    let again =
        commands::create_space(&e.vela, "Fix it", &["/nope".to_string()], None, None).unwrap_err();
    assert_eq!(again.kind, "space_exists");
    let bad =
        commands::create_space(&e.vela, "Other", &["/nope".to_string()], None, None).unwrap_err();
    assert_eq!(bad.kind, "not_a_repo");
    let json = serde_json::to_value(&bad).unwrap();
    assert_eq!(json["kind"], "not_a_repo");
    assert!(json["message"].as_str().unwrap().contains("/nope"));
}

#[test]
fn hunks_are_your_pending_edits_then_staged() {
    let e = env();
    let s = space(&e);
    let w = wt(&s);
    write(&w, "a.txt", &BODY.replace("two\n", "TWO\n"));
    write(&w, "new.txt", "hello\n");
    let hs = commands::hunks(&e.vela, "fix-it").unwrap();
    assert_eq!(hs.len(), 2);
    assert!(
        hs.iter()
            .all(|h| h.origin == Origin::You && h.state == HunkState::Pending)
    );
    let st = commands::status(&e.vela, "fix-it").unwrap();
    assert_eq!(st.len(), 2);
    assert_eq!(
        commands::up_next(&e.vela, "fix-it").unwrap(),
        UpNext::Review { count: 2 }
    );

    let a = hs.iter().find(|h| h.path == "a.txt").unwrap();
    let staged = commands::stage_hunk(&e.vela, "fix-it", &a.id).unwrap();
    assert_eq!(staged.state, HunkState::Staged);
    let hs = commands::hunks(&e.vela, "fix-it").unwrap();
    assert_eq!(hs.len(), 2);
    assert_eq!(
        hs.iter()
            .filter(|h| h.state == HunkState::Staged)
            .map(|h| h.path.as_str())
            .collect::<Vec<_>>(),
        ["a.txt"]
    );

    let back = commands::unstage_hunk(&e.vela, "fix-it", &a.id).unwrap();
    assert_eq!(back.state, HunkState::Pending);
    assert!(
        commands::hunks(&e.vela, "fix-it")
            .unwrap()
            .iter()
            .all(|h| h.state == HunkState::Pending)
    );
    let err = commands::stage_hunk(&e.vela, "fix-it", "nope").unwrap_err();
    assert_eq!(err.kind, "hunk_not_found");
}

#[test]
fn reject_persists_and_filters() {
    let e = env();
    let s = space(&e);
    write(&wt(&s), "a.txt", &BODY.replace("two\n", "TWO\n"));
    let hs = commands::hunks(&e.vela, "fix-it").unwrap();
    assert_eq!(hs.len(), 1);
    let r = commands::reject_hunk(&e.vela, "fix-it", &hs[0].id).unwrap();
    assert_eq!(r.state, HunkState::Rejected);
    assert!(commands::hunks(&e.vela, "fix-it").unwrap().is_empty());

    let file = e.vela.home.join("spaces/fix-it.rejected.json");
    let stored: Vec<String> = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(stored, [hs[0].id.clone()]);
    // A fresh handle (a restart) still filters it; the space list ignores the json file.
    let again = Vela::new(e.vela.home.clone());
    assert!(commands::hunks(&again, "fix-it").unwrap().is_empty());
    assert_eq!(commands::list_spaces(&again).unwrap().len(), 1);

    // Undo puts it back as pending.
    let h = commands::unstage_hunk(&e.vela, "fix-it", &hs[0].id).unwrap();
    assert_eq!(h.state, HunkState::Pending);
    assert_eq!(commands::hunks(&e.vela, "fix-it").unwrap().len(), 1);
}

#[test]
fn reads_and_writes_inside_the_worktree() {
    let e = env();
    let s = space(&e);
    assert_eq!(
        commands::read_file(&e.vela, "fix-it", "api", "src/b.txt").unwrap(),
        "b\n"
    );
    commands::write_file(&e.vela, "fix-it", "api", "src/b.txt", "changed\n").unwrap();
    assert_eq!(
        fs::read_to_string(wt(&s).join("src/b.txt")).unwrap(),
        "changed\n"
    );
    // New file in a new directory.
    commands::write_file(&e.vela, "fix-it", "api", "deep/er/c.txt", "c").unwrap();
    assert!(wt(&s).join("deep/er/c.txt").is_file());
    // Listing shows tracked and untracked, not deleted files.
    fs::remove_file(wt(&s).join("a.txt")).unwrap();
    let files = commands::list_files(&e.vela, "fix-it").unwrap();
    let f = |p: &str| FileRef {
        repo: "api".into(),
        path: p.into(),
    };
    assert!(files.contains(&f("src/b.txt")));
    assert!(files.contains(&f("deep/er/c.txt")));
    assert!(!files.contains(&f("a.txt")));
    assert_eq!(
        commands::read_file(&e.vela, "fix-it", "nope", "x")
            .unwrap_err()
            .kind,
        "repo_not_found"
    );
}

#[test]
fn refuses_paths_outside_the_worktree() {
    let e = env();
    let s = space(&e);
    let secret = e.root.join("secret.txt");
    fs::write(&secret, "top secret").unwrap();
    for bad in [
        "../secret.txt",
        "src/../../secret.txt",
        "/etc/passwd",
        secret.to_str().unwrap(),
        ".git/config",
        "",
        "..",
    ] {
        let r = commands::read_file(&e.vela, "fix-it", "api", bad).unwrap_err();
        assert_eq!(r.kind, "forbidden_path", "read {bad:?}");
        let w = commands::write_file(&e.vela, "fix-it", "api", bad, "x").unwrap_err();
        assert_eq!(w.kind, "forbidden_path", "write {bad:?}");
    }
    assert_eq!(fs::read_to_string(&secret).unwrap(), "top secret");

    // Symlink escapes: a file link, a directory link and a dangling link.
    let w = wt(&s);
    std::os::unix::fs::symlink(&secret, w.join("link.txt")).unwrap();
    std::os::unix::fs::symlink(&e.root, w.join("outdir")).unwrap();
    std::os::unix::fs::symlink(e.root.join("missing.txt"), w.join("dangling")).unwrap();
    for bad in [
        "link.txt",
        "outdir/secret.txt",
        "outdir/new.txt",
        "dangling",
    ] {
        let r = commands::read_file(&e.vela, "fix-it", "api", bad);
        assert_eq!(r.unwrap_err().kind, "forbidden_path", "read {bad:?}");
        let r = commands::write_file(&e.vela, "fix-it", "api", bad, "pwn");
        assert_eq!(r.unwrap_err().kind, "forbidden_path", "write {bad:?}");
    }
    assert_eq!(fs::read_to_string(&secret).unwrap(), "top secret");
    assert!(!e.root.join("new.txt").exists());
    assert!(!e.root.join("missing.txt").exists());

    // A link that stays inside is fine.
    std::os::unix::fs::symlink(w.join("src"), w.join("inside")).unwrap();
    assert_eq!(
        commands::read_file(&e.vela, "fix-it", "api", "inside/b.txt").unwrap(),
        "b\n"
    );
}

#[test]
fn commits_staged_hunks_per_repo() {
    let e = env();
    let s = space(&e);
    let err = commands::commit(&e.vela, "fix-it", "nothing", None).unwrap_err();
    assert_eq!(err.kind, "nothing_to_commit");
    assert_eq!(
        commands::commit(&e.vela, "fix-it", "  ", None)
            .unwrap_err()
            .kind,
        "invalid_input"
    );

    write(&wt(&s), "a.txt", &BODY.replace("two\n", "TWO\n"));
    let hs = commands::hunks(&e.vela, "fix-it").unwrap();
    commands::stage_hunk(&e.vela, "fix-it", &hs[0].id).unwrap();
    assert_eq!(
        commands::up_next(&e.vela, "fix-it").unwrap(),
        UpNext::Commit { repos: 1, files: 1 }
    );
    let r = commands::commit(&e.vela, "fix-it", "Shout two", None).unwrap();
    assert_eq!(r.repos, ["api"]);
    assert_eq!(r.branch, "feat/fix-it");
    assert_eq!(
        sh(&wt(&s), &["log", "-1", "--format=%s"]).trim(),
        "Shout two"
    );
    assert!(commands::hunks(&e.vela, "fix-it").unwrap().is_empty());
}

#[test]
fn window_numbers() {
    let e = env();
    space(&e);
    assert_eq!(commands::next_window(&e.vela).unwrap(), 2);
    commands::set_window(&e.vela, "fix-it", Some(2)).unwrap();
    assert_eq!(commands::next_window(&e.vela).unwrap(), 3);
    assert_eq!(commands::list_spaces(&e.vela).unwrap()[0].window, Some(2));
    commands::clear_windows(&e.vela).unwrap();
    assert_eq!(commands::list_spaces(&e.vela).unwrap()[0].window, None);
    assert_eq!(
        commands::set_window(&e.vela, "ghost", None)
            .unwrap_err()
            .kind,
        "space_not_found"
    );
}

#[test]
fn scans_repos_two_levels_deep() {
    let e = env();
    let root = e.root.join("code");
    repo(&root, "one", &[("f", "1")]);
    repo(&root, "group/two", &[("f", "2")]);
    repo(&root, "group/deeper/three", &[("f", "3")]);
    repo(&root, "node_modules/pkg", &[("f", "4")]);
    repo(&root, "target/thing", &[("f", "5")]);
    repo(&root, ".hidden", &[("f", "6")]);
    fs::create_dir_all(root.join("plain/dir")).unwrap();
    // A second root, and Vela's own worktrees inside a root.
    let other = e.root.join("other");
    repo(&other, "four", &[("f", "7")]);
    let home = root.join("vela-home");
    repo(&home, "worktrees", &[("f", "8")]);

    let found = commands::scan_repos(&[root.clone(), other.clone()], &home);
    let names: Vec<String> = found
        .iter()
        .map(|p| {
            Path::new(p)
                .strip_prefix(&e.root)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(names, ["code/group/two", "code/one", "other/four"]);

    assert_eq!(
        commands::roots_from(Some("/a:/b::/c"), None),
        [PathBuf::from("/a"), "/b".into(), "/c".into()]
    );
    assert_eq!(
        commands::roots_from(None, Some("/home/u".into())),
        [PathBuf::from("/home/u/Work")]
    );
    assert_eq!(
        commands::roots_from(Some(" "), Some("/home/u".into())),
        [PathBuf::from("/home/u/Work")]
    );
}

#[test]
fn watch_classifies_paths() {
    let root = Root {
        worktree: "/v/wt/api".into(),
        git_dir: Some("/src/api/.git/worktrees/api".into()),
    };
    let roots = [root];
    let c = |p: &str| watch::classify(&roots, Path::new(p));
    assert_eq!(c("/v/wt/api/src/a.rs"), Some(ChangeKind::File));
    assert_eq!(c("/v/wt/api/node_modules/x/y.js"), None);
    assert_eq!(c("/v/wt/api/target/debug/x"), None);
    assert_eq!(c("/v/wt/api/.git"), None);
    assert_eq!(
        c("/src/api/.git/worktrees/api/index"),
        Some(ChangeKind::State)
    );
    assert_eq!(
        c("/src/api/.git/worktrees/api/HEAD"),
        Some(ChangeKind::State)
    );
    assert_eq!(c("/src/api/.git/worktrees/api/index.lock"), None);
    assert_eq!(c("/src/api/.git/worktrees/api/logs/HEAD"), None);
    assert_eq!(c("/elsewhere/file"), None);
    let batch = |ps: &[&str]| watch::classify_batch(&roots, ps.iter().map(|p| Path::new(*p)));
    assert_eq!(
        batch(&["/v/wt/api/a", "/src/api/.git/worktrees/api/index"]),
        Some(ChangeKind::State)
    );
    assert_eq!(
        batch(&["/v/wt/api/a", "/v/wt/api/target/x"]),
        Some(ChangeKind::File)
    );
    assert_eq!(batch(&["/v/wt/api/target/x"]), None);
}

#[test]
fn watcher_emits_for_a_real_edit() {
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    let e = env();
    let s = space(&e);
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let emit: watch::Emit = Arc::new(move |ev| {
        let _ = tx.lock().unwrap().send(ev);
    });
    let watchers = watch::Watchers::default();
    watchers.sync(&e.vela, &emit);
    std::thread::sleep(Duration::from_millis(300));
    write(&wt(&s), "a.txt", "edited\n");
    let ev = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("a change event");
    assert_eq!(ev.space_id, "fix-it");
    assert_eq!(ev.kind, ChangeKind::File);
    // Staging touches the index of the worktree's git dir.
    std::thread::sleep(Duration::from_millis(500));
    while rx.try_recv().is_ok() {}
    sh(&wt(&s), &["add", "a.txt"]);
    let ev = loop {
        let ev = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a state event");
        if ev.kind == ChangeKind::State {
            break ev;
        }
    };
    let json = serde_json::to_value(&ev).unwrap();
    assert_eq!(json["spaceId"], "fix-it");
    assert_eq!(json["kind"], "state");
}

#[test]
fn commit_plan_validate_and_commit_groups() {
    use vela_core::model::{CommitRules, CommitType};
    let e = env();
    let s = space(&e);
    let w = wt(&s);
    write(&w, "src/new.ts", "export const a = 1\n");
    write(&w, "tests/new.test.ts", "test('a', () => {})\n");
    sh(&w, &["add", "-A"]);
    let plan = commands::commit_plan(&e.vela, "fix-it").unwrap();
    assert_eq!(plan.groups.len(), 2);
    assert_eq!(plan.groups[0].kind, CommitType::Feat);
    assert_eq!(plan.groups[1].kind, CommitType::Test);
    let json = serde_json::to_value(&plan).unwrap();
    assert_eq!(json["groups"][0]["kind"], "feat");
    assert!(json["rules"]["headerMax"].is_number());
    assert!(json["groups"][0]["breakingReason"].is_null());

    let rules = CommitRules::default();
    assert!(commands::validate_message("feat: ok", &rules, true).is_empty());
    assert_eq!(commands::validate_message("nope", &rules, true).len(), 1);
    assert!(commands::validate_message("nope", &rules, false).is_empty());

    let r = commands::commit_groups(&e.vela, "fix-it", true, plan.groups.clone(), Some("hotfix"))
        .unwrap();
    assert_eq!(r.repos, vec!["api"]);
    assert_eq!(r.commits.len(), 2);
    assert_eq!(r.branch, "feat/fix-it");
    let body = sh(&w, &["log", "-1", "--format=%B"]);
    assert!(body.contains("Vela-Override: hotfix"), "{body}");
    let err = commands::commit_groups(&e.vela, "fix-it", true, vec![], None).unwrap_err();
    assert_eq!(err.kind, "nothing_to_commit");
}

#[test]
fn links_add_list_remove_and_open_rules() {
    let e = env();
    let s = space(&e);
    let cfg = vela_core::links::IssueConfig::default();
    assert!(
        commands::list_links_with(&e.vela, "fix-it", &cfg)
            .unwrap()
            .is_empty()
    );
    let l =
        commands::add_link(&e.vela, "fix-it", "https://staging.acme.dev/x", None, None).unwrap();
    assert_eq!(l.title, "Staging acme.dev");
    let p = commands::add_link(
        &e.vela,
        "fix-it",
        "https://acme.dev/doc",
        Some("Doc"),
        Some("paste"),
    )
    .unwrap();
    assert_eq!(serde_json::to_value(&p).unwrap()["source"], "paste");
    let all = commands::list_links_with(&e.vela, "fix-it", &cfg).unwrap();
    assert_eq!(all.len(), 2);
    // Repo links show up through the worktree.
    write(
        &wt(&s),
        ".vela/links.toml",
        "[[links]]\nurl = \"https://grafana.acme.io/d/x/api\"\n",
    );
    assert_eq!(
        commands::list_links_with(&e.vela, "fix-it", &cfg)
            .unwrap()
            .len(),
        3
    );
    commands::remove_link(&e.vela, "fix-it", &l.id).unwrap();
    assert_eq!(
        commands::list_links_with(&e.vela, "fix-it", &cfg)
            .unwrap()
            .len(),
        2
    );
    let err = commands::remove_link(&e.vela, "fix-it", &l.id).unwrap_err();
    assert_eq!(err.kind, "link_not_found");
    let bad = commands::add_link(&e.vela, "fix-it", "javascript:alert(1)", None, None).unwrap_err();
    assert_eq!(bad.kind, "invalid_input");

    assert!(commands::check_openable("https://acme.dev").is_ok());
    assert!(commands::check_openable(" http://localhost:3000 ").is_ok());
    for u in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "ftp://x.y",
        "mailto:a@b.c",
        "",
    ] {
        assert!(commands::check_openable(u).is_err(), "{u}");
    }
}

#[test]
fn declares_repos_by_path() {
    let e = env();
    let vela = Vela::new(e.root.join("home"));
    let a = repo(&e.root.join("elsewhere"), "alpha", &[("f", "1")]);
    let b = repo(&e.root.join("elsewhere"), "beta", &[("f", "2")]);
    commands::declare_repo(&vela, a.to_str().unwrap()).unwrap();
    let list = commands::declare_repo(&vela, b.to_str().unwrap()).unwrap();
    let ca = fs::canonicalize(&a).unwrap().to_string_lossy().into_owned();
    let cb = fs::canonicalize(&b).unwrap().to_string_lossy().into_owned();
    assert_eq!(&list[..2], [cb.clone(), ca.clone()]);
    // Declaring again moves it to the front without duplicating.
    let list = commands::declare_repo(&vela, a.to_str().unwrap()).unwrap();
    assert_eq!(list.iter().filter(|p| **p == ca).count(), 1);
    assert_eq!(list[0], ca);
    // Not a repo, missing folder, Vela worktree.
    fs::create_dir_all(e.root.join("plain")).unwrap();
    assert!(commands::declare_repo(&vela, e.root.join("plain").to_str().unwrap()).is_err());
    assert!(commands::declare_repo(&vela, "/no/such/dir").is_err());
    let inside = repo(&e.root.join("home/worktrees"), "x", &[("f", "3")]);
    assert!(commands::declare_repo(&vela, inside.to_str().unwrap()).is_err());
}

#[test]
fn space_files_and_file_staging() {
    let e = env();
    let s = space(&e);
    write(&wt(&s), "src/new.txt", "n\n");
    let tree = commands::space_files(&e.vela, &s.id).unwrap();
    assert_eq!(tree.len(), 1);
    assert_eq!(tree[0].repo, "api");
    assert!(tree[0].files.iter().any(|f| f.path == "src/b.txt"));
    commands::stage_file(&e.vela, &s.id, "api", "src/new.txt").unwrap();
    let tree = commands::space_files(&e.vela, &s.id).unwrap();
    let f = tree[0]
        .files
        .iter()
        .find(|f| f.path == "src/new.txt")
        .unwrap();
    assert!(f.staged.is_some() && f.unstaged.is_none());
    commands::unstage_file(&e.vela, &s.id, "api", "src/new.txt").unwrap();
    assert!(commands::stage_file(&e.vela, &s.id, "api", "../x").is_err());
}

#[test]
fn creates_a_repo_and_a_space_on_it() {
    let e = env();
    let parent = e.root.join("code");
    fs::create_dir_all(&parent).unwrap();
    // The test process may have no git identity: give one through the environment.
    // SAFETY: tests in this binary that read these vars do not run concurrently with a write.
    unsafe {
        std::env::set_var("GIT_AUTHOR_NAME", "T");
        std::env::set_var("GIT_AUTHOR_EMAIL", "t@t");
        std::env::set_var("GIT_COMMITTER_NAME", "T");
        std::env::set_var("GIT_COMMITTER_EMAIL", "t@t");
    }
    let path = commands::create_repo(&e.vela, parent.to_str().unwrap(), "fresh").unwrap();
    assert!(Path::new(&path).join(".git").is_dir());
    assert!(Path::new(&path).join("README.md").is_file());
    assert_eq!(commands::list_repos(&e.vela).unwrap()[0], path);
    // A worktree can branch from it right away.
    let s = commands::create_space(
        &e.vela,
        "Fresh start",
        std::slice::from_ref(&path),
        None,
        None,
    )
    .unwrap();
    assert_eq!(s.repos.len(), 1);
    // Bad names and existing folders are refused.
    for bad in ["", ".hidden", "a/b"] {
        assert!(
            commands::create_repo(&e.vela, parent.to_str().unwrap(), bad).is_err(),
            "{bad}"
        );
    }
    assert!(commands::create_repo(&e.vela, parent.to_str().unwrap(), "fresh").is_err());
}
