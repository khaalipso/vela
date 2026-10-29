//! Branches of a space: how the default name is made, which branches a repo has, and
//! renaming the branch of a space.
//!
//! The default name comes from a template in the global config:
//!
//! ```toml
//! [spaces]
//! branch = "feat/{slug}"   # {slug} {name} {user} {date} {ticket}
//! ```

use std::path::Path;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::git::git;
use crate::{Vela, store};

pub const DEFAULT_TEMPLATE: &str = "feat/{slug}";

/// A branch name git accepts (`git check-ref-format --branch` rules, checked without git).
pub fn is_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && name != "@"
        && !name
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "~^:?*[\\".contains(c))
        && !name.split('/').any(|part| part.starts_with('.'))
}

fn user_slug() -> String {
    let u = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    let s = crate::space::slugify(&u);
    if s.is_empty() { "me".to_string() } else { s }
}

/// The branch name for a space called `name`, from `template`.
pub fn render(template: &str, name: &str) -> String {
    render_with(template, name, None)
}

/// [`render`] with the ticket of the task for `{ticket}`. Without a ticket, `{ticket}` goes
/// away with the separator next to it (`{ticket}-{slug}` gives `{slug}`).
pub fn render_with(template: &str, name: &str, ticket: Option<&str>) -> String {
    let template = if template.trim().is_empty() {
        DEFAULT_TEMPLATE
    } else {
        template.trim()
    };
    let slug = crate::space::slugify(name);
    let date = crate::space::rfc3339(SystemTime::now())[..10].to_string();
    let template = match ticket.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => template.replace("{ticket}", t),
        None => {
            let mut t = template.to_string();
            for sep in ["-", "_", "/", "."] {
                t = t
                    .replace(&format!("{{ticket}}{sep}"), "")
                    .replace(&format!("{sep}{{ticket}}"), "");
            }
            t.replace("{ticket}", "")
        }
    };
    let out = template
        .replace("{slug}", &slug)
        .replace("{name}", &slug)
        .replace("{user}", &user_slug())
        .replace("{date}", &date);
    // Whatever the template gives, end up with something git takes.
    let cleaned: String = out
        .chars()
        .map(|c| {
            if c.is_whitespace() || "~^:?*[\\".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(['/', '.', '-']).replace("..", ".");
    if is_valid(&cleaned) {
        cleaned
    } else {
        format!("feat/{slug}")
    }
}

/// The template of the global config, or the default.
pub fn template_from_env() -> String {
    crate::config::load_global(crate::paths::config_dir_from_env().as_deref())
        .config
        .spaces
        .branch
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_TEMPLATE.to_string())
}

/// One branch of a repo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// `main`, or `origin/feat/x` for a remote one.
    pub name: String,
    pub remote: bool,
    /// Checked out in the repo itself.
    pub current: bool,
    /// Last commit: relative date and subject.
    pub when: String,
    pub subject: String,
}

/// Local branches (newest first), then remote ones without a local branch of the same name.
pub fn list(repo: &Path) -> Result<Vec<BranchInfo>> {
    let current = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let out = git(
        repo,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%09%(committerdate:relative)%09%(subject)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut local: Vec<BranchInfo> = Vec::new();
    let mut remote: Vec<BranchInfo> = Vec::new();
    for line in out.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(r), when, subject) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let info = |name: String, remote: bool| BranchInfo {
            current: !remote && name == current,
            name,
            remote,
            when: when.unwrap_or("").to_string(),
            subject: subject.unwrap_or("").to_string(),
        };
        if let Some(n) = r.strip_prefix("refs/heads/") {
            // Agent branches are Vela's own.
            if !n.contains("--") && !n.starts_with("vela/") {
                local.push(info(n.to_string(), false));
            }
        } else if let Some(n) = r.strip_prefix("refs/remotes/")
            && !n.ends_with("/HEAD")
        {
            remote.push(info(n.to_string(), true));
        }
    }
    remote.retain(|r| {
        let short = r.name.split_once('/').map_or(r.name.as_str(), |(_, b)| b);
        !local.iter().any(|l| l.name == short)
    });
    local.extend(remote);
    Ok(local)
}

/// How a space gets its branch in one repo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A new branch from `base`.
    New { base: String },
    /// The local branch that already exists.
    Local,
    /// A new local branch tracking `origin/<branch>` (a PR branch, a teammate's branch).
    Remote { upstream: String },
}

/// Where the branch `name` comes from in `repo`.
pub fn source_of(repo: &Path, name: &str, base: &str) -> Source {
    let has = |r: &str| git(repo, &["rev-parse", "--verify", "--quiet", r]).is_ok();
    if has(&format!("refs/heads/{name}")) {
        return Source::Local;
    }
    let remotes = git(repo, &["remote"]).unwrap_or_default();
    for remote in remotes.lines().map(str::trim).filter(|r| !r.is_empty()) {
        let upstream = format!("{remote}/{name}");
        if has(&format!("refs/remotes/{upstream}")) {
            return Source::Remote { upstream };
        }
    }
    Source::New {
        base: base.to_string(),
    }
}

/// The worktree a local branch is checked out in, if any (git refuses a second one).
pub fn checked_out_in(repo: &Path, name: &str) -> Option<String> {
    let list = git(repo, &["worktree", "list", "--porcelain"]).ok()?;
    let mut path = None;
    for line in list.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p.to_string());
        } else if line.strip_prefix("branch refs/heads/") == Some(name) {
            return path;
        }
    }
    None
}

/// Rename the branch of one repo of a space (`repo`), or of every repo (None), with the
/// branches of its agents (`<branch>--<agent>`). The worktrees stay where they are; an
/// upstream stays set. Renaming every repo also changes the default branch of the space.
pub fn rename(vela: &Vela, id: &str, new: &str, repo: Option<&str>) -> Result<crate::model::Space> {
    let new = new.trim();
    if !is_valid(new) {
        return Err(Error::Invalid(format!("{new} is not a valid branch name")));
    }
    let mut space = store::load(vela, id)?;
    if let Some(name) = repo
        && space.repo(name).is_none()
    {
        return Err(Error::RepoNotFound(name.to_string()));
    }
    let targets: Vec<usize> = (0..space.repos.len())
        .filter(|&i| repo.is_none_or(|n| space.repos[i].name == n))
        .filter(|&i| space.repos[i].branch != new)
        .collect();
    // Check every repo first, so a clash leaves nothing half renamed.
    for &i in &targets {
        let r = &space.repos[i];
        let src = Path::new(&r.source);
        if git(
            src,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{new}"),
            ],
        )
        .is_ok()
        {
            return Err(Error::Invalid(format!(
                "{} already has a branch {new}",
                r.name
            )));
        }
    }
    for &i in &targets {
        let r = &space.repos[i];
        let old = r.branch.clone();
        let src = Path::new(&r.source);
        git(src, &["branch", "-m", &old, new])?;
        let pattern = format!("refs/heads/{old}--*");
        if let Ok(refs) = git(
            src,
            &["for-each-ref", "--format=%(refname:short)", &pattern],
        ) {
            for b in refs.lines().map(str::trim).filter(|b| !b.is_empty()) {
                let suffix = &b[old.len()..];
                let _ = git(src, &["branch", "-m", b, &format!("{new}{suffix}")]);
            }
        }
        space.repos[i].branch = new.to_string();
    }
    if repo.is_none() {
        space.branch = new.to_string();
    }
    store::save(vela, &space)?;
    Ok(space)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_names() {
        for ok in ["feat/x", "louis/fix-42", "release-1.2", "a"] {
            assert!(is_valid(ok), "{ok}");
        }
        for bad in [
            "",
            "-x",
            "a b",
            "a..b",
            "a/",
            "x.lock",
            "a~1",
            "a:b",
            "a/.hidden",
            "@",
            "a//b",
        ] {
            assert!(!is_valid(bad), "{bad}");
        }
    }

    #[test]
    fn templates_render_to_valid_names() {
        assert_eq!(
            render("feat/{slug}", "Refunds in checkout"),
            "feat/refunds-in-checkout"
        );
        assert_eq!(render("", "X"), "feat/x");
        let u = render("{user}/{slug}", "Billing v2");
        assert!(u.ends_with("/billing-v2") && is_valid(&u), "{u}");
        let d = render("{date}-{slug}", "Fix");
        assert!(d.ends_with("-fix") && d.len() == 14, "{d}");
        assert!(is_valid(&render("weird name: {slug}?", "a")));
    }

    #[test]
    fn ticket_in_templates() {
        assert_eq!(
            render_with("feat/{ticket}-{slug}", "Refunds", Some("PAY-412")),
            "feat/PAY-412-refunds"
        );
        assert_eq!(
            render_with("feat/{ticket}-{slug}", "Refunds", None),
            "feat/refunds"
        );
        assert_eq!(render_with("{ticket}/{slug}", "Refunds", None), "refunds");
        assert_eq!(
            render_with("feat/{slug}_{ticket}", "Refunds", Some(" ")),
            "feat/refunds"
        );
    }
}
