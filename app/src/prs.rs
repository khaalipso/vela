//! Pull requests of a space, through the GitHub CLI (`gh`): for each repo, the PR of the space
//! branch with its reviews, comments, review threads on lines, and checks. Also opening a PR
//! (push, then `gh pr create --fill`) and commenting on one.

use std::path::Path;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use vela_core::model::Space;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReview {
    pub author: String,
    /// APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING.
    pub state: String,
    pub body: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub author: String,
    pub body: String,
    pub at: String,
    pub url: String,
}

/// A review comment on a line, with the replies under it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrThread {
    pub id: u64,
    pub path: String,
    /// None when the line is gone from the diff (outdated).
    pub line: Option<u32>,
    pub author: String,
    pub body: String,
    pub at: String,
    pub url: String,
    pub diff_hunk: String,
    pub replies: Vec<PrComment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    /// pass, fail, pending, skipped, neutral.
    pub state: String,
    pub url: String,
    pub workflow: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// OPEN, CLOSED, MERGED.
    pub state: String,
    pub draft: bool,
    /// APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty.
    pub review_decision: String,
    pub author: String,
    pub base: String,
    pub head: String,
    pub additions: u64,
    pub deletions: u64,
    pub mergeable: String,
    pub requested: Vec<String>,
    pub reviews: Vec<PrReview>,
    pub comments: Vec<PrComment>,
    pub threads: Vec<PrThread>,
    pub checks: Vec<PrCheck>,
}

/// The PR of one repo of the space, or why there is none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPr {
    pub repo: String,
    pub branch: String,
    pub pr: Option<PullRequest>,
    /// gh missing, not logged in, no GitHub remote...
    pub error: Option<String>,
}

const VIEW_FIELDS: &str = "number,title,url,state,isDraft,reviewDecision,author,baseRefName,headRefName,additions,deletions,mergeable,reviewRequests,reviews,comments,statusCheckRollup";

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn login(v: &Value) -> String {
    v["login"]
        .as_str()
        .or_else(|| v["name"].as_str())
        .unwrap_or("someone")
        .to_string()
}

/// One check of `statusCheckRollup` (a CheckRun or a commit StatusContext) as pass, fail...
fn check_of(c: &Value) -> PrCheck {
    let name = c["name"]
        .as_str()
        .or_else(|| c["context"].as_str())
        .unwrap_or("check")
        .to_string();
    let state = match (
        c["status"].as_str().unwrap_or(""),
        c["conclusion"]
            .as_str()
            .or_else(|| c["state"].as_str())
            .unwrap_or(""),
    ) {
        (_, "SUCCESS") => "pass",
        (
            _,
            "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE",
        ) => "fail",
        (_, "SKIPPED") => "skipped",
        (_, "NEUTRAL" | "STALE") => "neutral",
        (_, "PENDING" | "EXPECTED") => "pending",
        ("COMPLETED", _) => "neutral",
        _ => "pending",
    };
    PrCheck {
        name,
        state: state.to_string(),
        url: c["detailsUrl"]
            .as_str()
            .or_else(|| c["targetUrl"].as_str())
            .unwrap_or("")
            .to_string(),
        workflow: s(&c["workflowName"]),
    }
}

/// The JSON of `gh pr view --json <VIEW_FIELDS>`, threads left empty.
pub fn parse_view(v: &Value) -> PullRequest {
    let arr = |k: &str| v[k].as_array().cloned().unwrap_or_default();
    PullRequest {
        number: v["number"].as_u64().unwrap_or(0),
        title: s(&v["title"]),
        url: s(&v["url"]),
        state: s(&v["state"]),
        draft: v["isDraft"].as_bool().unwrap_or(false),
        review_decision: s(&v["reviewDecision"]),
        author: login(&v["author"]),
        base: s(&v["baseRefName"]),
        head: s(&v["headRefName"]),
        additions: v["additions"].as_u64().unwrap_or(0),
        deletions: v["deletions"].as_u64().unwrap_or(0),
        mergeable: s(&v["mergeable"]),
        requested: arr("reviewRequests")
            .iter()
            .map(|r| {
                r["login"]
                    .as_str()
                    .or_else(|| r["name"].as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .filter(|l| !l.is_empty())
            .collect(),
        reviews: arr("reviews")
            .iter()
            .map(|r| PrReview {
                author: login(&r["author"]),
                state: s(&r["state"]),
                body: s(&r["body"]),
                at: s(&r["submittedAt"]),
            })
            .collect(),
        comments: arr("comments")
            .iter()
            .map(|c| PrComment {
                author: login(&c["author"]),
                body: s(&c["body"]),
                at: s(&c["createdAt"]),
                url: s(&c["url"]),
            })
            .collect(),
        threads: Vec::new(),
        checks: arr("statusCheckRollup").iter().map(check_of).collect(),
    }
}

/// The JSON of `gh api repos/<o>/<r>/pulls/<n>/comments`: replies go under their thread.
pub fn parse_threads(v: &Value) -> Vec<PrThread> {
    let items = v.as_array().cloned().unwrap_or_default();
    let mut threads: Vec<PrThread> = Vec::new();
    for c in items.iter().filter(|c| c["in_reply_to_id"].is_null()) {
        threads.push(PrThread {
            id: c["id"].as_u64().unwrap_or(0),
            path: s(&c["path"]),
            line: c["line"]
                .as_u64()
                .or_else(|| c["original_line"].as_u64())
                .map(|l| l as u32),
            author: login(&c["user"]),
            body: s(&c["body"]),
            at: s(&c["created_at"]),
            url: s(&c["html_url"]),
            diff_hunk: s(&c["diff_hunk"]),
            replies: Vec::new(),
        });
    }
    for c in items.iter().filter(|c| !c["in_reply_to_id"].is_null()) {
        let parent = c["in_reply_to_id"].as_u64().unwrap_or(0);
        if let Some(t) = threads.iter_mut().find(|t| t.id == parent) {
            t.replies.push(PrComment {
                author: login(&c["user"]),
                body: s(&c["body"]),
                at: s(&c["created_at"]),
                url: s(&c["html_url"]),
            });
        }
    }
    threads
}

/// `https://github.com/<owner>/<repo>/pull/<n>` → `<owner>/<repo>`.
pub fn repo_of_url(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let parts: Vec<&str> = rest.split('/').collect();
    (parts.len() >= 3).then(|| format!("{}/{}", parts[1], parts[2]))
}

fn gh(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("gh")
        .args(args)
        .current_dir(dir)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "the GitHub CLI (gh) is not installed".to_string()
            } else {
                format!("cannot run gh: {e}")
            }
        })?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn no_pr(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("no pull requests found") || e.contains("no open pull requests")
}

/// The PR of the branch of one repo, in its worktree.
fn repo_pr(repo: &str, worktree: &Path, branch: &str) -> RepoPr {
    let mut out = RepoPr {
        repo: repo.to_string(),
        branch: branch.to_string(),
        pr: None,
        error: None,
    };
    match gh(worktree, &["pr", "view", branch, "--json", VIEW_FIELDS]) {
        Err(e) if no_pr(&e) => {}
        Err(e) => out.error = Some(e.lines().next().unwrap_or("gh failed").to_string()),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Err(e) => out.error = Some(format!("unexpected answer from gh: {e}")),
            Ok(v) => {
                let mut pr = parse_view(&v);
                if let Some(slug) = repo_of_url(&pr.url) {
                    let path = format!("repos/{slug}/pulls/{}/comments?per_page=100", pr.number);
                    if let Ok(t) = gh(worktree, &["api", &path])
                        && let Ok(v) = serde_json::from_str::<Value>(&t)
                    {
                        pr.threads = parse_threads(&v);
                    }
                }
                out.pr = Some(pr);
            }
        },
    }
    out
}

/// The PRs of every repo of the space, fetched in parallel.
pub fn space_prs(space: &Space) -> Vec<RepoPr> {
    std::thread::scope(|scope| {
        let jobs: Vec<_> = space
            .repos
            .iter()
            .map(|r| {
                let branch = r.branch.clone();
                scope.spawn(move || repo_pr(&r.name, Path::new(&r.worktree), &branch))
            })
            .collect();
        jobs.into_iter()
            .map(|j| j.join().expect("pr thread"))
            .collect()
    })
}

fn worktree_of<'a>(space: &'a Space, repo: &str) -> AppResult<&'a Path> {
    space
        .repos
        .iter()
        .find(|r| r.name == repo)
        .map(|r| Path::new(r.worktree.as_str()))
        .ok_or_else(|| AppError::invalid(format!("no repo {repo} in this space")))
}

/// Push the space branch and open a PR from its commits. Returns its URL.
pub fn create_pr(space: &Space, repo: &str, draft: bool) -> AppResult<String> {
    let wt = worktree_of(space, repo)?;
    let branch = space.branch_of(repo);
    vela_core::git::git(wt, &["push", "-u", "origin", branch])
        .map_err(|e| AppError::new("git", format!("push failed: {e}")))?;
    let mut args = vec!["pr", "create", "--fill", "--head", branch];
    if draft {
        args.push("--draft");
    }
    let out = gh(wt, &args).map_err(|e| AppError::new("gh", e))?;
    Ok(out
        .lines()
        .rev()
        .find(|l| l.starts_with("http"))
        .unwrap_or("")
        .trim()
        .to_string())
}

/// Add a comment to the PR of the space branch.
pub fn comment_pr(space: &Space, repo: &str, body: &str) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::invalid("the comment is empty"));
    }
    let wt = worktree_of(space, repo)?;
    gh(
        wt,
        &[
            "pr",
            "comment",
            space.branch_of(repo),
            "--body",
            body.trim(),
        ],
    )
    .map_err(|e| AppError::new("gh", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_pr_with_reviews_comments_and_checks() {
        let v = json!({
            "number": 12, "title": "Refunds", "url": "https://github.com/acme/api/pull/12",
            "state": "OPEN", "isDraft": false, "reviewDecision": "CHANGES_REQUESTED",
            "author": {"login": "ana"}, "baseRefName": "main", "headRefName": "feat/refunds",
            "additions": 40, "deletions": 3, "mergeable": "MERGEABLE",
            "reviewRequests": [{"login": "bob"}, {"name": "core-team"}],
            "reviews": [{"author": {"login": "bob"}, "state": "CHANGES_REQUESTED", "body": "Check the signature", "submittedAt": "2026-10-20T10:00:00Z"}],
            "comments": [{"author": {"login": "eve"}, "body": "LGTM after that", "createdAt": "2026-10-20T11:00:00Z", "url": "u"}],
            "statusCheckRollup": [
                {"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "d", "workflowName": "CI"},
                {"__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS", "conclusion": ""},
                {"__typename": "StatusContext", "context": "deploy", "state": "SUCCESS", "targetUrl": "t"}
            ]
        });
        let pr = parse_view(&v);
        assert_eq!(pr.number, 12);
        assert_eq!(pr.review_decision, "CHANGES_REQUESTED");
        assert_eq!(pr.requested, vec!["bob", "core-team"]);
        assert_eq!(pr.reviews[0].state, "CHANGES_REQUESTED");
        assert_eq!(pr.comments[0].author, "eve");
        let states: Vec<&str> = pr.checks.iter().map(|c| c.state.as_str()).collect();
        assert_eq!(states, vec!["fail", "pending", "pass"]);
        assert_eq!(pr.checks[2].name, "deploy");
        assert_eq!(repo_of_url(&pr.url).as_deref(), Some("acme/api"));
    }

    #[test]
    fn replies_go_under_their_thread() {
        let v = json!([
            {"id": 1, "in_reply_to_id": null, "path": "src/a.ts", "line": 10, "user": {"login": "bob"}, "body": "Why?", "created_at": "t1", "html_url": "u1", "diff_hunk": "@@"},
            {"id": 2, "in_reply_to_id": 1, "path": "src/a.ts", "line": 10, "user": {"login": "ana"}, "body": "Because", "created_at": "t2", "html_url": "u2"},
            {"id": 3, "in_reply_to_id": null, "path": "src/b.ts", "line": null, "original_line": 4, "user": {"login": "bob"}, "body": "Old", "created_at": "t3", "html_url": "u3"}
        ]);
        let t = parse_threads(&v);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].replies.len(), 1);
        assert_eq!(t[0].replies[0].author, "ana");
        assert_eq!(t[1].line, Some(4));
    }

    #[test]
    fn no_pr_is_not_an_error() {
        assert!(no_pr("no pull requests found for branch \"feat/x\""));
        assert!(!no_pr("HTTP 401: Bad credentials"));
    }
}
