//! Right-click menu operations on temporary git repos. No webview, no desktop trash.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use vela_app::commands;
use vela_app::fileops::{self, Disposal};
use vela_core::Vela;
use vela_core::model::Space;

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

fn space(e: &Env) -> Space {
    let dir = e.root.join("api");
    fs::create_dir_all(&dir).unwrap();
    sh(&dir, &["init", "-q", "-b", "main"]);
    sh(&dir, &["config", "user.name", "Test"]);
    sh(&dir, &["config", "user.email", "test@example.com"]);
    sh(&dir, &["config", "commit.gpgsign", "false"]);
    write(&dir, "a.txt", "original\n");
    write(&dir, "src/b.txt", "b\n");
    sh(&dir, &["add", "-A"]);
    sh(&dir, &["commit", "-q", "-m", "init"]);
    commands::create_space(
        &e.vela,
        "Menu",
        &[dir.to_string_lossy().into_owned()],
        None,
        None,
    )
    .unwrap()
}

fn wt(s: &Space) -> PathBuf {
    PathBuf::from(&s.repos[0].worktree)
}

/// A trash that records the path and removes it, like the real one.
fn fake_trash(log: &RefCell<Vec<PathBuf>>) -> impl Fn(&Path) -> Result<(), String> + '_ {
    move |p: &Path| {
        log.borrow_mut().push(p.to_path_buf());
        if p.is_dir() {
            fs::remove_dir_all(p).map_err(|e| e.to_string())
        } else {
            fs::remove_file(p).map_err(|e| e.to_string())
        }
    }
}

fn no_trash(_: &Path) -> Result<(), String> {
    Err("no trash here".to_string())
}

#[test]
fn creates_files_and_folders_inside_the_worktree() {
    let e = env();
    let s = space(&e);
    fileops::create_file(&e.vela, &s.id, "api", "src/new/c.txt").unwrap();
    assert!(wt(&s).join("src/new/c.txt").is_file());
    fileops::create_dir(&e.vela, &s.id, "api", "docs/deep").unwrap();
    assert!(wt(&s).join("docs/deep").is_dir());
    // Existing names are refused, nothing is overwritten.
    let again = fileops::create_file(&e.vela, &s.id, "api", "a.txt").unwrap_err();
    assert_eq!(again.kind, "invalid_input");
    assert_eq!(
        fs::read_to_string(wt(&s).join("a.txt")).unwrap(),
        "original\n"
    );
    assert_eq!(
        fileops::create_dir(&e.vela, &s.id, "api", "src")
            .unwrap_err()
            .kind,
        "invalid_input"
    );
}

#[test]
fn every_operation_refuses_paths_outside_the_worktree() {
    let e = env();
    let s = space(&e);
    let outside = e.root.join("evil.txt");
    fs::write(&outside, "x").unwrap();
    for bad in [
        "../evil.txt",
        "/etc/passwd",
        ".git/config",
        "src/../../evil.txt",
    ] {
        let kinds = [
            (
                "create_file",
                fileops::create_file(&e.vela, &s.id, "api", bad),
            ),
            (
                "create_dir",
                fileops::create_dir(&e.vela, &s.id, "api", bad),
            ),
            (
                "rename to",
                fileops::rename_path(&e.vela, &s.id, "api", "a.txt", bad),
            ),
            (
                "rename from",
                fileops::rename_path(&e.vela, &s.id, "api", bad, "z.txt"),
            ),
            ("discard", fileops::discard_file(&e.vela, &s.id, "api", bad)),
        ];
        for (what, r) in kinds {
            assert_eq!(r.unwrap_err().kind, "forbidden_path", "{what} {bad}");
        }
        assert_eq!(
            fileops::delete_path(&e.vela, &s.id, "api", bad, true)
                .unwrap_err()
                .kind,
            "forbidden_path",
            "delete {bad}"
        );
        assert_eq!(
            fileops::absolute_path(&e.vela, &s.id, "api", bad)
                .unwrap_err()
                .kind,
            "forbidden_path",
            "absolute {bad}"
        );
    }
    assert!(outside.exists());
    // A symlink that leads out of the worktree is refused too.
    std::os::unix::fs::symlink(&e.root, wt(&s).join("link")).unwrap();
    assert_eq!(
        fileops::delete_path(&e.vela, &s.id, "api", "link/evil.txt", true)
            .unwrap_err()
            .kind,
        "forbidden_path"
    );
    assert!(outside.exists());
    // The worktree root is only reachable through the empty path of reveal / terminal.
    assert_eq!(
        fileops::absolute_path(&e.vela, &s.id, "api", "").unwrap(),
        fs::canonicalize(wt(&s)).unwrap().to_string_lossy()
    );
    assert_eq!(
        fileops::delete_path(&e.vela, &s.id, "api", "", true)
            .unwrap_err()
            .kind,
        "forbidden_path"
    );
}

#[test]
fn renames_files_and_folders() {
    let e = env();
    let s = space(&e);
    fileops::rename_path(&e.vela, &s.id, "api", "a.txt", "renamed.txt").unwrap();
    assert!(!wt(&s).join("a.txt").exists());
    assert_eq!(
        fs::read_to_string(wt(&s).join("renamed.txt")).unwrap(),
        "original\n"
    );
    fileops::rename_path(&e.vela, &s.id, "api", "src", "lib/inner").unwrap();
    assert_eq!(
        fs::read_to_string(wt(&s).join("lib/inner/b.txt")).unwrap(),
        "b\n"
    );
    // Targets that exist, sources that do not, and moves into itself are refused.
    for (from, to) in [
        ("renamed.txt", "lib"),
        ("missing", "x"),
        ("lib", "lib/inner/deeper"),
    ] {
        assert_eq!(
            fileops::rename_path(&e.vela, &s.id, "api", from, to)
                .unwrap_err()
                .kind,
            "invalid_input",
            "{from} -> {to}"
        );
    }
}

#[test]
fn delete_goes_to_the_trash_or_is_removed_for_good() {
    let e = env();
    let s = space(&e);
    let log = RefCell::new(Vec::new());
    let d = fileops::delete_path_with(&e.vela, &s.id, "api", "a.txt", false, &fake_trash(&log))
        .unwrap();
    assert_eq!(d, Disposal::Trashed);
    assert_eq!(log.borrow().len(), 1);
    assert!(!wt(&s).join("a.txt").exists());
    // A folder goes as a whole.
    let d =
        fileops::delete_path_with(&e.vela, &s.id, "api", "src", false, &fake_trash(&log)).unwrap();
    assert_eq!(d, Disposal::Trashed);
    assert!(!wt(&s).join("src").exists());
    // No trash on this machine: a typed error, and nothing is deleted until `permanent`.
    write(&wt(&s), "keep.txt", "k");
    let err =
        fileops::delete_path_with(&e.vela, &s.id, "api", "keep.txt", false, &no_trash).unwrap_err();
    assert_eq!(err.kind, "no_trash");
    assert!(wt(&s).join("keep.txt").exists());
    let d = fileops::delete_path_with(&e.vela, &s.id, "api", "keep.txt", true, &no_trash).unwrap();
    assert_eq!(d, Disposal::Deleted);
    assert!(!wt(&s).join("keep.txt").exists());
    // Missing paths are an error, not a silent success.
    assert_eq!(
        fileops::delete_path_with(&e.vela, &s.id, "api", "nope", true, &no_trash)
            .unwrap_err()
            .kind,
        "invalid_input"
    );
}

#[test]
fn discard_restores_head_and_removes_untracked_files() {
    let e = env();
    let s = space(&e);
    let dir = wt(&s);
    // A modified tracked file goes back to HEAD.
    write(&dir, "a.txt", "scribbles\n");
    let log = RefCell::new(Vec::new());
    fileops::discard_file_with(&e.vela, &s.id, "api", "a.txt", &fake_trash(&log)).unwrap();
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "original\n");
    assert!(log.borrow().is_empty());
    // A file deleted in the worktree comes back.
    fs::remove_file(dir.join("src/b.txt")).unwrap();
    fileops::discard_file_with(&e.vela, &s.id, "api", "src/b.txt", &fake_trash(&log)).unwrap();
    assert_eq!(fs::read_to_string(dir.join("src/b.txt")).unwrap(), "b\n");
    // An untracked file is deleted (trash first).
    write(&dir, "fresh.txt", "new\n");
    fileops::discard_file_with(&e.vela, &s.id, "api", "fresh.txt", &fake_trash(&log)).unwrap();
    assert!(!dir.join("fresh.txt").exists());
    assert_eq!(log.borrow().len(), 1);
    // ... and for good when the trash fails.
    write(&dir, "fresh2.txt", "new\n");
    fileops::discard_file_with(&e.vela, &s.id, "api", "fresh2.txt", &no_trash).unwrap();
    assert!(!dir.join("fresh2.txt").exists());
    // Nothing to discard on a clean file.
    assert_eq!(
        fileops::discard_file_with(&e.vela, &s.id, "api", "a.txt", &no_trash)
            .unwrap_err()
            .kind,
        "invalid_input"
    );
}

#[test]
fn discard_keeps_what_is_staged() {
    let e = env();
    let s = space(&e);
    let dir = wt(&s);
    write(&dir, "a.txt", "staged version\n");
    sh(&dir, &["add", "a.txt"]);
    write(&dir, "a.txt", "staged version\nplus unstaged\n");
    fileops::discard_file_with(&e.vela, &s.id, "api", "a.txt", &no_trash).unwrap();
    assert_eq!(
        fs::read_to_string(dir.join("a.txt")).unwrap(),
        "staged version\n"
    );
    assert_eq!(sh(&dir, &["show", ":a.txt"]), "staged version\n");
    // Only staged changes left: discard is refused, the user unstages first.
    assert_eq!(
        fileops::discard_file_with(&e.vela, &s.id, "api", "a.txt", &no_trash)
            .unwrap_err()
            .kind,
        "invalid_input"
    );
}

#[test]
fn terminal_order_is_env_then_xdg_then_common_terminals() {
    fn has(names: &'static [&'static str]) -> impl Fn(&str) -> bool {
        move |p: &str| names.contains(&p)
    }
    // $TERMINAL wins, arguments kept.
    assert_eq!(
        fileops::terminal_command(
            Some("foot -e"),
            &has(&["foot", "xdg-terminal-exec", "xterm"])
        ),
        Some(vec!["foot".to_string(), "-e".to_string()])
    );
    // $TERMINAL not installed: xdg-terminal-exec.
    assert_eq!(
        fileops::terminal_command(Some("nope"), &has(&["xdg-terminal-exec", "xterm"])),
        Some(vec!["xdg-terminal-exec".to_string()])
    );
    // Then the common list, in order.
    assert_eq!(
        fileops::terminal_command(None, &has(&["xterm", "kitty"])),
        Some(vec!["kitty".to_string()])
    );
    assert_eq!(fileops::terminal_command(Some("  "), &has(&[])), None);
}

#[test]
fn terminal_dir_is_the_folder_or_the_folder_of_the_file() {
    let e = env();
    let s = space(&e);
    let root = fs::canonicalize(wt(&s)).unwrap();
    assert_eq!(
        fileops::terminal_dir(&e.vela, &s.id, "api", "src").unwrap(),
        root.join("src")
    );
    assert_eq!(
        fileops::terminal_dir(&e.vela, &s.id, "api", "src/b.txt").unwrap(),
        root.join("src")
    );
    assert_eq!(
        fileops::terminal_dir(&e.vela, &s.id, "api", "").unwrap(),
        root
    );
    assert_eq!(
        fileops::terminal_dir(&e.vela, &s.id, "api", "../x")
            .unwrap_err()
            .kind,
        "forbidden_path"
    );
}

#[test]
fn rename_color_archive_unarchive_and_remove_space() {
    let e = env();
    let s = space(&e);
    let r = fileops::rename_space(&e.vela, &s.id, "  Better name ").unwrap();
    assert_eq!(r.name, "Better name");
    assert_eq!(r.id, s.id);
    assert_eq!(r.branch, s.branch);
    assert_eq!(
        fileops::rename_space(&e.vela, &s.id, "  ")
            .unwrap_err()
            .kind,
        "invalid_input"
    );

    let c = fileops::set_space_color(&e.vela, &s.id, "#7db8f5").unwrap();
    assert_eq!(c.color, "#7DB8F5");
    for bad in ["red", "#12345", "#GGGGGG", "7DB8F5"] {
        assert_eq!(
            fileops::set_space_color(&e.vela, &s.id, bad)
                .unwrap_err()
                .kind,
            "invalid_input",
            "{bad}"
        );
    }

    fileops::archive_space(&e.vela, &s.id).unwrap();
    assert!(commands::list_spaces(&e.vela).unwrap().is_empty());
    let hidden = fileops::list_archived(&e.vela).unwrap();
    assert_eq!(hidden.len(), 1);
    assert!(hidden[0].archived);
    assert!(wt(&s).exists(), "archiving keeps the worktrees");
    fileops::unarchive_space(&e.vela, &s.id).unwrap();
    assert_eq!(commands::list_spaces(&e.vela).unwrap().len(), 1);
    assert!(fileops::list_archived(&e.vela).unwrap().is_empty());

    // Remove: the worktree goes, a branch with unmerged commits is kept.
    write(&wt(&s), "new.txt", "work\n");
    sh(&wt(&s), &["add", "new.txt"]);
    sh(&wt(&s), &["commit", "-q", "-m", "work"]);
    let source = PathBuf::from(&s.repos[0].source);
    fileops::remove_space(&e.vela, &s.id).unwrap();
    assert!(!wt(&s).exists());
    assert!(commands::list_spaces(&e.vela).unwrap().is_empty());
    assert!(fileops::list_archived(&e.vela).unwrap().is_empty());
    let branches = sh(&source, &["branch", "--list", &s.branch]);
    assert!(
        branches.contains(&s.branch),
        "unmerged branch kept: {branches:?}"
    );
    assert_eq!(
        fileops::remove_space(&e.vela, &s.id).unwrap_err().kind,
        "space_not_found"
    );
}

#[test]
fn removing_a_merged_space_deletes_its_branch() {
    let e = env();
    let s = space(&e);
    let source = PathBuf::from(&s.repos[0].source);
    fileops::remove_space(&e.vela, &s.id).unwrap();
    assert!(
        sh(&source, &["branch", "--list", &s.branch])
            .trim()
            .is_empty()
    );
}

#[test]
fn deleting_a_staged_new_file_leaves_nothing_behind() {
    let e = env();
    let s = space(&e);
    write(&wt(&s), "src/new.txt", "n\n");
    sh(&wt(&s), &["add", "src/new.txt"]);
    let log = RefCell::new(Vec::new());
    fileops::delete_path_with(
        &e.vela,
        &s.id,
        "api",
        "src/new.txt",
        false,
        &fake_trash(&log),
    )
    .unwrap();
    assert!(
        !commands::status(&e.vela, &s.id)
            .unwrap()
            .iter()
            .any(|c| c.path == "src/new.txt")
    );
    let files = commands::space_files(&e.vela, &s.id).unwrap();
    assert!(!files[0].files.iter().any(|f| f.path == "src/new.txt"));
    // A tracked file deleted leaves the tree, its deletion waits in the Review.
    fileops::delete_path_with(&e.vela, &s.id, "api", "a.txt", false, &fake_trash(&log)).unwrap();
    let files = commands::space_files(&e.vela, &s.id).unwrap();
    assert!(!files[0].files.iter().any(|f| f.path == "a.txt"));
    assert!(
        commands::status(&e.vela, &s.id)
            .unwrap()
            .iter()
            .any(|c| c.path == "a.txt")
    );
}
