//! M0 integration tests on real temporary git repos.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use vela_core::Vela;
use vela_core::model::*;
use vela_core::{Error, commit, diff, space, stage, status, store, upnext};

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

/// A repo on branch `main` with the given committed files.
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

fn write(dir: &Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
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

fn wt(s: &Space, i: usize) -> PathBuf {
    PathBuf::from(&s.repos[i].worktree)
}

fn one_repo_space(e: &Env, files: &[(&str, &str)]) -> Space {
    let r = repo(&e.root, "app", files);
    space::create(&e.vela, "Task", &[r], None).unwrap()
}

#[test]
fn create_makes_branch_and_worktrees_in_two_repos() {
    let e = env();
    let a = repo(&e.root, "api", &[("a.txt", "a\n")]);
    let b = repo(&e.root, "web", &[("b.txt", "b\n")]);
    let s = space::create(&e.vela, "Refunds & Co!", &[&a, &b], None).unwrap();
    assert_eq!(s.id, "refunds-co");
    assert_eq!(s.branch, "feat/refunds-co");
    assert_eq!(s.color, "#E8A14A");
    assert_eq!(s.repos.len(), 2);
    assert_eq!(s.repos[0].base, "main");
    assert!(s.created_at.ends_with('Z') && s.created_at.len() == 20);
    for (i, src) in [&a, &b].iter().enumerate() {
        let w = wt(&s, i);
        assert_eq!(
            w,
            e.vela
                .home
                .join("worktrees/refunds-co")
                .join(&s.repos[i].name)
        );
        assert_eq!(
            sh(&w, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
            "feat/refunds-co"
        );
        assert!(sh(src, &["branch", "--list", "feat/refunds-co"]).contains("feat/refunds-co"));
    }
    assert_eq!(store::load(&e.vela, "refunds-co").unwrap(), s);
    assert_eq!(store::list(&e.vela).unwrap().len(), 1);
    // A second space takes the next color; same name is refused.
    let s2 = space::create(&e.vela, "Other", &[&a], Some("main")).unwrap();
    assert_eq!(s2.color, "#7DB8F5");
    assert!(matches!(
        space::create(&e.vela, "refunds co", &[&a], None),
        Err(Error::SpaceExists(_))
    ));
}

#[test]
fn clashing_repo_names_get_a_suffix() {
    let e = env();
    let a = repo(&e.root.join("one"), "app", &[("f", "1\n")]);
    let b = repo(&e.root.join("two"), "app", &[("f", "2\n")]);
    let s = space::create(&e.vela, "dup", &[&a, &b], None).unwrap();
    assert_eq!(s.repos[0].name, "app");
    assert_eq!(s.repos[1].name, "app-2");
}

#[test]
fn creation_rolls_back_when_a_later_repo_fails() {
    let e = env();
    let a = repo(&e.root, "api", &[("a", "a\n")]);
    let b = repo(&e.root, "web", &[("b", "b\n")]);
    sh(&b, &["branch", "feat/boom"]); // the branch already exists in the second repo
    let err = space::create(&e.vela, "boom", &[&a, &b], None).unwrap_err();
    assert!(matches!(err, Error::Git { .. }), "{err}");
    assert!(sh(&a, &["branch", "--list", "feat/boom"]).trim().is_empty());
    assert!(!sh(&a, &["worktree", "list"]).contains("boom"));
    assert!(!e.vela.home.join("worktrees/boom").exists());
    assert!(store::list(&e.vela).unwrap().is_empty());
}

#[test]
fn not_a_repo_is_rejected_before_anything_is_created() {
    let e = env();
    let plain = e.root.join("plain");
    fs::create_dir_all(&plain).unwrap();
    let err = space::create(&e.vela, "x", &[&plain], None).unwrap_err();
    assert!(matches!(err, Error::NotARepo(_)));
    assert!(!e.vela.home.join("worktrees").exists());
}

#[test]
fn archive_and_remove() {
    let e = env();
    let a = repo(&e.root, "api", &[("a", "a\n")]);
    let s = space::create(&e.vela, "gone", &[&a], None).unwrap();
    assert!(space::archive(&e.vela, "gone").unwrap().archived);
    assert!(store::load(&e.vela, "gone").unwrap().archived);
    space::remove(&e.vela, "gone").unwrap();
    assert!(!wt(&s, 0).exists());
    assert!(sh(&a, &["branch", "--list", "feat/gone"]).trim().is_empty());
    assert!(matches!(
        store::load(&e.vela, "gone"),
        Err(Error::SpaceNotFound(_))
    ));
}

#[test]
fn remove_keeps_an_unmerged_branch() {
    let e = env();
    let a = repo(&e.root, "api", &[("a", "a\n")]);
    let s = space::create(&e.vela, "wip", &[&a], None).unwrap();
    write(&wt(&s, 0), "a", "changed\n");
    sh(&wt(&s, 0), &["commit", "-qam", "work"]);
    space::remove(&e.vela, "wip").unwrap();
    assert!(sh(&a, &["branch", "--list", "feat/wip"]).contains("feat/wip"));
}

#[test]
fn status_splits_staged_unstaged_untracked_renamed() {
    let e = env();
    let s = one_repo_space(
        &e,
        &[
            ("m.txt", &numbered(10)),
            ("s.txt", &numbered(10)),
            ("old.txt", &numbered(10)),
        ],
    );
    let w = wt(&s, 0);
    write(&w, "m.txt", &numbered(10).replace("line 2\n", "two\n"));
    write(&w, "s.txt", &numbered(10).replace("line 3\n", "three\n"));
    sh(&w, &["add", "s.txt"]);
    sh(&w, &["mv", "old.txt", "new.txt"]);
    write(&w, "fresh.txt", "x\n");
    let mut ch = status::space_status(&s).unwrap();
    ch.sort_by(|a, b| a.path.cmp(&b.path));
    let get = |p: &str| ch.iter().find(|c| c.path == p).unwrap().clone();
    assert_eq!(get("m.txt").unstaged, Some(ChangeKind::Modified));
    assert_eq!(get("m.txt").staged, None);
    assert_eq!(get("s.txt").staged, Some(ChangeKind::Modified));
    assert_eq!(get("s.txt").unstaged, None);
    let r = get("new.txt");
    assert_eq!(r.staged, Some(ChangeKind::Renamed));
    assert_eq!(r.from.as_deref(), Some("old.txt"));
    assert_eq!(get("fresh.txt").unstaged, Some(ChangeKind::Untracked));
    assert_eq!(ch.len(), 4);
}

#[test]
fn status_reports_conflicts() {
    let e = env();
    let s = one_repo_space(&e, &[("c.txt", "base\n")]);
    let w = wt(&s, 0);
    sh(&w, &["checkout", "-q", "-b", "other"]);
    write(&w, "c.txt", "other\n");
    sh(&w, &["commit", "-qam", "other"]);
    sh(&w, &["checkout", "-q", "feat/task"]);
    write(&w, "c.txt", "mine\n");
    sh(&w, &["commit", "-qam", "mine"]);
    let _ = Command::new("git")
        .current_dir(&w)
        .args(["merge", "other"])
        .output();
    let ch = status::space_status(&s).unwrap();
    assert_eq!(ch[0].unstaged, Some(ChangeKind::Conflicted));
}

#[test]
fn worktree_diff_has_multiple_hunks_and_untracked_added_hunk() {
    let e = env();
    let s = one_repo_space(&e, &[("f.txt", &numbered(40))]);
    let w = wt(&s, 0);
    let edited = numbered(40)
        .replace("line 3\n", "three\n")
        .replace("line 35\n", "thirty-five\n");
    write(&w, "f.txt", &edited);
    write(&w, "new.txt", "a\nb\n");
    let hunks = diff::worktree_hunks(&s).unwrap();
    assert_eq!(hunks.len(), 3);
    assert!(
        hunks
            .iter()
            .all(|h| h.state == HunkState::Pending && h.origin == Origin::You)
    );
    let f: Vec<_> = hunks.iter().filter(|h| h.path == "f.txt").collect();
    assert_eq!(f.len(), 2);
    assert!(
        f[0].lines
            .iter()
            .any(|l| l.kind == LineKind::Add && l.text == "three")
    );
    let n = hunks.iter().find(|h| h.path == "new.txt").unwrap();
    assert_eq!((n.old_lines, n.new_start, n.new_lines), (0, 1, 2));
    assert!(n.lines.iter().all(|l| l.kind == LineKind::Add));
    assert!(diff::staged_hunks(&s).unwrap().is_empty());
}

#[test]
fn diff_handles_no_newline_new_deleted_and_renamed_files() {
    let e = env();
    let s = one_repo_space(
        &e,
        &[
            ("nonl.txt", "a\nb"),
            ("del.txt", "x\ny\n"),
            ("old.txt", &numbered(12)),
        ],
    );
    let w = wt(&s, 0);
    write(&w, "nonl.txt", "a\nc"); // still no newline at EOF
    fs::remove_file(w.join("del.txt")).unwrap();
    sh(&w, &["mv", "old.txt", "renamed.txt"]);
    write(
        &w,
        "renamed.txt",
        &numbered(12).replace("line 6\n", "six\n"),
    );
    write(&w, "added.txt", "q\n");
    sh(&w, &["add", "-A"]);
    let staged = diff::staged_hunks(&s).unwrap();
    assert!(staged.iter().all(|h| h.state == HunkState::Staged));
    let by = |p: &str| staged.iter().find(|h| h.path == p).unwrap();
    let nonl = by("nonl.txt");
    assert_eq!(nonl.lines.len(), 3); // context a, -b, +c; marker is not a line
    let del = by("del.txt");
    assert_eq!((del.new_lines, del.lines.len()), (0, 2));
    assert!(del.lines.iter().all(|l| l.kind == LineKind::Del));
    let add = by("added.txt");
    assert_eq!((add.old_lines, add.new_lines), (0, 1));
    let ren = by("renamed.txt");
    assert!(ren.lines.iter().any(|l| l.text == "six"));
    assert!(!staged.iter().any(|h| h.path == "old.txt"));
}

#[test]
fn stage_one_of_two_hunks_then_unstage() {
    let e = env();
    let s = one_repo_space(&e, &[("f.txt", &numbered(40))]);
    let w = wt(&s, 0);
    let edited = numbered(40)
        .replace("line 3\n", "three\n")
        .replace("line 35\n", "thirty-five\n");
    write(&w, "f.txt", &edited);
    let hunks = diff::worktree_hunks(&s).unwrap();
    assert_eq!(hunks.len(), 2);
    let (first, second) = (hunks[0].clone(), hunks[1].clone());

    stage::stage_hunk(&s, &second.id).unwrap();
    let ch = status::space_status(&s).unwrap();
    assert_eq!(ch.len(), 1);
    assert_eq!(ch[0].staged, Some(ChangeKind::Modified));
    assert_eq!(ch[0].unstaged, Some(ChangeKind::Modified));
    let staged = diff::staged_hunks(&s).unwrap();
    assert_eq!(staged.len(), 1);
    assert_eq!(staged[0].id, second.id);
    let rest = diff::worktree_hunks(&s).unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].id, first.id);
    // The worktree file itself is untouched.
    assert_eq!(fs::read_to_string(w.join("f.txt")).unwrap(), edited);

    // Now the other one: the file is fully staged.
    stage::stage_hunk(&s, &first.id).unwrap();
    let ch = status::space_status(&s).unwrap();
    assert_eq!(
        (ch[0].staged, ch[0].unstaged),
        (Some(ChangeKind::Modified), None)
    );

    // Unstage the first: back to both sides.
    stage::unstage_hunk(&s, &first.id).unwrap();
    let ch = status::space_status(&s).unwrap();
    assert_eq!(ch[0].unstaged, Some(ChangeKind::Modified));
    assert_eq!(ch[0].staged, Some(ChangeKind::Modified));
    stage::unstage_hunk(&s, &second.id).unwrap();
    let ch = status::space_status(&s).unwrap();
    assert_eq!(
        (ch[0].staged, ch[0].unstaged),
        (None, Some(ChangeKind::Modified))
    );
    assert_eq!(diff::worktree_hunks(&s).unwrap().len(), 2);
    assert!(matches!(
        stage::stage_hunk(&s, "deadbeef"),
        Err(Error::HunkNotFound(_))
    ));
}

#[test]
fn stage_hunk_without_trailing_newline_and_deletion() {
    let e = env();
    let s = one_repo_space(&e, &[("nonl.txt", "a\nb"), ("del.txt", "x\ny\n")]);
    let w = wt(&s, 0);
    write(&w, "nonl.txt", "a\nc");
    fs::remove_file(w.join("del.txt")).unwrap();
    for h in diff::worktree_hunks(&s).unwrap() {
        stage::stage_hunk(&s, &h.id).unwrap();
    }
    assert!(diff::worktree_hunks(&s).unwrap().is_empty());
    assert_eq!(diff::staged_hunks(&s).unwrap().len(), 2);
    for h in diff::staged_hunks(&s).unwrap() {
        stage::unstage_hunk(&s, &h.id).unwrap();
    }
    assert!(diff::staged_hunks(&s).unwrap().is_empty());
    assert_eq!(diff::worktree_hunks(&s).unwrap().len(), 2);
}

#[test]
fn untracked_hunk_stage_and_unstage() {
    let e = env();
    let s = one_repo_space(&e, &[("a.txt", "a\n")]);
    let w = wt(&s, 0);
    write(&w, "dir/new.txt", "one\ntwo\nthree\n");
    let h = diff::worktree_hunks(&s).unwrap().remove(0);
    assert_eq!(h.path, "dir/new.txt");
    stage::stage_hunk(&s, &h.id).unwrap();
    let ch = status::space_status(&s).unwrap();
    assert_eq!(
        (ch[0].staged, ch[0].unstaged),
        (Some(ChangeKind::Added), None)
    );
    let sh_ = diff::staged_hunks(&s).unwrap();
    assert_eq!(sh_.len(), 1);
    assert_eq!(sh_[0].id, h.id); // same content, same id on both sides
    stage::unstage_hunk(&s, &h.id).unwrap();
    let ch = status::space_status(&s).unwrap();
    assert_eq!(
        (ch[0].staged, ch[0].unstaged),
        (None, Some(ChangeKind::Untracked))
    );
    assert!(w.join("dir/new.txt").exists());
}

#[test]
fn file_level_stage_and_unstage() {
    let e = env();
    let s = one_repo_space(&e, &[("a.txt", "a\n")]);
    let w = wt(&s, 0);
    write(&w, "a.txt", "b\n");
    stage::stage_file(&s, "app", "a.txt").unwrap();
    assert_eq!(
        status::space_status(&s).unwrap()[0].staged,
        Some(ChangeKind::Modified)
    );
    stage::unstage_file(&s, "app", "a.txt").unwrap();
    assert_eq!(status::space_status(&s).unwrap()[0].staged, None);
    assert!(matches!(
        stage::stage_file(&s, "nope", "a.txt"),
        Err(Error::RepoNotFound(_))
    ));
}

#[test]
fn hunk_id_is_stable_after_inserting_lines_above() {
    let e = env();
    let s = one_repo_space(&e, &[("f.txt", &numbered(40))]);
    let w = wt(&s, 0);
    write(&w, "f.txt", &numbered(40).replace("line 30\n", "thirty\n"));
    let before = diff::worktree_hunks(&s).unwrap();
    assert_eq!(before.len(), 1);
    // Insert lines at the top of the file, far above the hunk.
    let moved = format!(
        "new top 1\nnew top 2\nnew top 3\n{}",
        numbered(40).replace("line 30\n", "thirty\n")
    );
    write(&w, "f.txt", &moved);
    let after = diff::worktree_hunks(&s).unwrap();
    let old_hunk = after
        .iter()
        .find(|h| h.lines.iter().any(|l| l.text == "thirty"))
        .unwrap();
    assert_eq!(old_hunk.id, before[0].id);
    assert_ne!(old_hunk.new_start, before[0].new_start);
}

#[test]
fn multi_repo_commit_returns_two_shas_and_skips_clean_repo() {
    let e = env();
    let a = repo(&e.root, "api", &[("a.txt", "a\n")]);
    let b = repo(&e.root, "web", &[("b.txt", "b\n")]);
    let c = repo(&e.root, "docs", &[("c.txt", "c\n")]);
    let s = space::create(&e.vela, "multi", &[&a, &b, &c], None).unwrap();
    // Nothing staged yet.
    assert!(matches!(
        commit::commit(&s, "x"),
        Err(Error::NothingToCommit)
    ));
    write(&wt(&s, 0), "a.txt", "a2\n");
    write(&wt(&s, 1), "b.txt", "b2\n");
    sh(&wt(&s, 0), &["add", "-A"]);
    sh(&wt(&s, 1), &["add", "-A"]);
    let done = commit::commit(&s, "Refund flow").unwrap();
    assert_eq!(done.len(), 2);
    assert_eq!(done[0].0, "api");
    assert_eq!(done[1].0, "web");
    assert_ne!(done[0].1, done[1].1);
    for (i, (_, sha)) in done.iter().enumerate() {
        assert_eq!(sh(&wt(&s, i), &["rev-parse", "HEAD"]).trim(), sha);
        assert_eq!(
            sh(&wt(&s, i), &["log", "-1", "--format=%s"]).trim(),
            "Refund flow"
        );
    }
    // The clean repo got no commit.
    assert_eq!(sh(&wt(&s, 2), &["rev-list", "--count", "HEAD"]).trim(), "1");
    assert!(status::space_status(&s).unwrap().is_empty());
}

#[test]
fn upnext_pure_cases() {
    let fc = |repo: &str, path: &str, staged: bool| FileChange {
        repo: repo.into(),
        path: path.into(),
        from: None,
        staged: staged.then_some(ChangeKind::Modified),
        unstaged: (!staged).then_some(ChangeKind::Modified),
    };
    assert_eq!(upnext::up_next(0, &[], &[]), UpNext::Nothing);
    assert_eq!(
        upnext::up_next(0, &[fc("a", "x", false)], &[]),
        UpNext::Nothing
    );
    assert_eq!(upnext::up_next(3, &[], &[]), UpNext::Review { count: 3 });
    let staged = [fc("a", "x", true), fc("a", "y", true), fc("b", "z", true)];
    assert_eq!(
        upnext::up_next(0, &staged, &[]),
        UpNext::Commit { repos: 2, files: 3 }
    );
    // Review beats commit; a question beats everything.
    assert_eq!(
        upnext::up_next(2, &staged, &[]),
        UpNext::Review { count: 2 }
    );
    let q = [("dev".to_string(), "which db?".to_string())];
    assert_eq!(
        upnext::up_next(2, &staged, &q),
        UpNext::AgentQuestion {
            agent: "dev".into(),
            text: "which db?".into()
        }
    );
}

#[test]
fn upnext_follows_the_live_space() {
    let e = env();
    let s = one_repo_space(&e, &[("f.txt", "a\n")]);
    assert_eq!(upnext::space_up_next(&s).unwrap(), UpNext::Nothing);
    write(&wt(&s, 0), "f.txt", "b\n");
    assert_eq!(
        upnext::space_up_next(&s).unwrap(),
        UpNext::Review { count: 1 }
    );
    let h = diff::worktree_hunks(&s).unwrap().remove(0);
    stage::stage_hunk(&s, &h.id).unwrap();
    assert_eq!(
        upnext::space_up_next(&s).unwrap(),
        UpNext::Commit { repos: 1, files: 1 }
    );
}

#[test]
fn diff_between_two_worktrees_of_a_repo() {
    let e = env();
    let r = repo(
        &e.root,
        "app",
        &[("f.txt", &numbered(10)), (".gitignore", "target/\n")],
    );
    let s = space::create(&e.vela, "base", &[&r], None).unwrap();
    // A second worktree stands in for an agent's.
    let agent = e.vela.home.join("agent/app");
    sh(
        &r,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "agent",
            agent.to_str().unwrap(),
            "main",
        ],
    );
    write(&agent, "f.txt", &numbered(10).replace("line 5\n", "five\n"));
    write(&agent, "extra.txt", "hi\n");
    write(&agent, "target/junk", "ignored\n");
    let hunks = diff::diff_between(&wt(&s, 0), &agent).unwrap();
    let paths: Vec<_> = hunks.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(hunks.len(), 2, "{paths:?}");
    assert!(paths.contains(&"f.txt") && paths.contains(&"extra.txt"));
    assert!(hunks.iter().all(|h| h.repo == "app"));
    // The real indexes were not touched.
    assert!(status::space_status(&s).unwrap().is_empty());
}

#[test]
fn home_resolution_order() {
    use std::ffi::OsString;
    use vela_core::paths::resolve_home;
    let s = |v: &str| Some(OsString::from(v));
    assert_eq!(
        resolve_home(s("/v"), s("/x"), s("/h")).unwrap(),
        PathBuf::from("/v")
    );
    assert_eq!(
        resolve_home(None, s("/x"), s("/h")).unwrap(),
        PathBuf::from("/x/vela")
    );
    assert_eq!(
        resolve_home(s(""), None, s("/h")).unwrap(),
        PathBuf::from("/h/.local/share/vela")
    );
    assert!(resolve_home(None, None, None).is_err());
}

#[test]
fn rfc3339_formats_known_instants() {
    use std::time::{Duration, UNIX_EPOCH};
    assert_eq!(space::rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00Z");
    assert_eq!(
        space::rfc3339(UNIX_EPOCH + Duration::from_secs(1_709_164_800 + 3661)),
        "2024-02-29T01:01:01Z"
    );
    let long = space::slugify(&"Hello, World! ".repeat(10));
    assert!(long.len() <= 40 && !long.ends_with('-'));
    assert_eq!(space::slugify("  A  b--C "), "a-b-c");
}
