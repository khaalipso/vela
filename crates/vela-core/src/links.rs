//! Links: the context of a space (issues, PRs, docs, dashboards, environments).
//!
//! Links come from three places: the ones the user added (stored in the space),
//! the ones detected from the branch name and commit subjects, and the ones the
//! repo shares in `.vela/links.toml`. [`list_links`] merges them.

use std::fs;
use std::path::Path;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::git::git;
use crate::model::{Link, LinkKind, LinkSource, Provider, Space, SpaceRepo};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/// What a URL tells about itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    pub kind: LinkKind,
    pub provider: Provider,
    pub key: Option<String>,
    /// A readable title guessed from the URL alone.
    pub title: String,
}

struct Parsed {
    host: String,
    segments: Vec<String>,
}

/// Split an http(s) URL into lowercase host (no port, no userinfo) and path segments.
fn parse_url(url: &str) -> Option<Parsed> {
    let url = url.trim();
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    let rest = if lower.starts_with("https://") {
        &url[8..]
    } else if lower.starts_with("http://") {
        &url[7..]
    } else {
        return None;
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = authority.split(':').next().unwrap_or(authority);
    if host.is_empty() {
        return None;
    }
    let path = tail.split(['?', '#']).next().unwrap_or("");
    let segments = path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    Some(Parsed {
        host: host.to_ascii_lowercase(),
        segments,
    })
}

/// True for an http or https URL with a host.
pub fn is_http_url(url: &str) -> bool {
    parse_url(url).is_some()
}

fn is_issue_key(s: &str) -> bool {
    let Some((prefix, num)) = s.rsplit_once('-') else {
        return false;
    };
    prefix.len() >= 2
        && prefix.starts_with(|c: char| c.is_ascii_uppercase())
        && prefix
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && !num.is_empty()
        && num.chars().all(|c| c.is_ascii_digit())
}

fn humanize(slug: &str) -> String {
    slug.replace(['-', '_', '+'], " ").trim().to_string()
}

fn done(
    kind: LinkKind,
    provider: Provider,
    key: Option<String>,
    title: impl Into<String>,
) -> Classified {
    Classified {
        kind,
        provider,
        key,
        title: title.into(),
    }
}

fn host_is(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

fn is_number(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// Classify a URL by host and path. Pure, no network.
pub fn classify(url: &str) -> Classified {
    let Some(p) = parse_url(url) else {
        return done(LinkKind::Other, Provider::Url, None, url.trim());
    };
    let h = p.host.as_str();
    let seg: Vec<&str> = p.segments.iter().map(String::as_str).collect();
    let find = |name: &str| seg.iter().position(|s| *s == name);

    if h.ends_with(".atlassian.net") {
        if let Some(i) = find("browse")
            && let Some(k) = seg.get(i + 1).filter(|k| is_issue_key(k))
        {
            return done(LinkKind::Issue, Provider::Jira, Some(k.to_string()), *k);
        }
        if seg.first() == Some(&"wiki") {
            let title = seg
                .iter()
                .skip_while(|s| **s != "pages")
                .nth(2)
                .map(|s| humanize(s))
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| "Confluence page".to_string());
            return done(LinkKind::Doc, Provider::Confluence, None, title);
        }
    }
    if host_is(h, "linear.app")
        && let Some(i) = find("issue")
        && let Some(k) = seg.get(i + 1).filter(|k| is_issue_key(k))
    {
        return done(LinkKind::Issue, Provider::Linear, Some(k.to_string()), *k);
    }
    if host_is(h, "github.com") && seg.len() >= 4 && is_number(seg[3]) {
        let key = format!("{}/{}#{}", seg[0], seg[1], seg[3]);
        match seg[2] {
            "issues" => return done(LinkKind::Issue, Provider::Github, Some(key.clone()), key),
            "pull" => {
                return done(
                    LinkKind::PullRequest,
                    Provider::Github,
                    Some(key.clone()),
                    key,
                );
            }
            _ => {}
        }
    }
    if host_is(h, "gitlab.com") || h.starts_with("gitlab.") {
        for (marker, kind, sign) in [
            ("merge_requests", LinkKind::PullRequest, "!"),
            ("issues", LinkKind::Issue, "#"),
        ] {
            // Group paths can be nested: the project path is everything before `/-/` or the marker.
            if let Some(i) = find(marker)
                && i >= 2
                && let Some(n) = seg.get(i + 1).filter(|n| is_number(n))
            {
                let project: Vec<&str> = seg[..i].iter().copied().filter(|s| *s != "-").collect();
                let key = format!("{}{sign}{n}", project.join("/"));
                return done(kind, Provider::Gitlab, Some(key.clone()), key);
            }
        }
    }
    if host_is(h, "sentry.io")
        && let Some(i) = find("issues")
        && let Some(id) = seg.get(i + 1)
    {
        return done(
            LinkKind::Error,
            Provider::Sentry,
            Some(id.to_string()),
            format!("Sentry issue {id}"),
        );
    }
    if host_is(h, "figma.com") && matches!(seg.first(), Some(&"file" | &"design" | &"proto")) {
        let title = seg
            .get(2)
            .map(|s| humanize(s))
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "Figma file".to_string());
        return done(LinkKind::Design, Provider::Figma, None, title);
    }
    if host_is(h, "notion.so") || host_is(h, "notion.site") {
        let title = seg
            .last()
            .map(|s| {
                // Notion slugs end with the 32 hex characters of the page id.
                let words: Vec<&str> = s.split('-').collect();
                let keep = match words.last() {
                    Some(l) if l.len() == 32 && l.chars().all(|c| c.is_ascii_hexdigit()) => {
                        &words[..words.len() - 1]
                    }
                    _ => &words[..],
                };
                keep.join(" ")
            })
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "Notion page".to_string());
        return done(LinkKind::Doc, Provider::Notion, None, title);
    }
    if h == "docs.google.com" {
        let title = match seg.first() {
            Some(&"spreadsheets") => "Google Sheet",
            Some(&"presentation") => "Google Slides",
            _ => "Google Doc",
        };
        return done(LinkKind::Doc, Provider::GoogleDocs, None, title);
    }
    if h.contains("grafana") {
        let title = if seg.first() == Some(&"d") {
            seg.get(2)
                .map(|s| humanize(s))
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| "Grafana dashboard".to_string())
        } else {
            "Grafana dashboard".to_string()
        };
        return done(LinkKind::Dashboard, Provider::Grafana, None, title);
    }
    if h.starts_with("app.datadoghq.") || host_is(h, "datadoghq.com") || host_is(h, "datadoghq.eu")
    {
        return done(
            LinkKind::Dashboard,
            Provider::Datadog,
            None,
            "Datadog dashboard",
        );
    }
    if host_is(h, "slack.com") && find("archives").is_some() {
        return done(LinkKind::Chat, Provider::Slack, None, "Slack thread");
    }
    if h == "localhost" || h == "127.0.0.1" {
        return done(LinkKind::Environment, Provider::Url, None, "Local");
    }
    if let Some(rest) = h.strip_prefix("staging.") {
        return done(
            LinkKind::Environment,
            Provider::Url,
            None,
            format!("Staging {rest}"),
        );
    }
    if let Some(rest) = h.strip_prefix("preview.") {
        return done(
            LinkKind::Environment,
            Provider::Url,
            None,
            format!("Preview {rest}"),
        );
    }
    if h.ends_with(".vercel.app") {
        return done(
            LinkKind::Environment,
            Provider::Url,
            None,
            format!("Preview {h}"),
        );
    }
    let title = match seg.as_slice() {
        [] => h.to_string(),
        [one] => format!("{h}/{one}"),
        [.., last] => format!("{h}/…/{last}"),
    };
    done(LinkKind::Other, Provider::Url, None, title)
}

// ---------------------------------------------------------------------------
// Ids and constructors
// ---------------------------------------------------------------------------

fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("l{h:016x}")
}

/// Stable id of a link: its url, else its key.
pub fn link_id(url: &str, key: Option<&str>) -> String {
    if url.is_empty() {
        fnv(&format!("key:{}", key.unwrap_or("")))
    } else {
        fnv(&format!("url:{url}"))
    }
}

/// Build a link from a URL, an optional title and a source.
pub fn make_link(url: &str, title: Option<&str>, source: LinkSource) -> Link {
    let url = url.trim().to_string();
    let c = classify(&url);
    let title = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or(c.title);
    Link {
        id: link_id(&url, c.key.as_deref()),
        kind: c.kind,
        provider: c.provider,
        url,
        title,
        key: c.key,
        source,
        summary: None,
    }
}

// ---------------------------------------------------------------------------
// Issue keys
// ---------------------------------------------------------------------------

/// Prefixes that look like issue keys but are not (UTF-8, SHA-256, ...).
const NOT_KEYS: &[&str] = &[
    "UTF", "SHA", "ISO", "HTTP", "HTTPS", "RFC", "MD", "AES", "RSA", "TLS", "SSL", "IPV", "CVE",
    "ECMA", "WCAG", "BIP", "EIP", "PEP",
];

/// Issue keys (`[A-Z][A-Z0-9]+-\d+`) in a text, in order of appearance, without duplicates.
pub fn detect_keys(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let alnum = |c: u8| c.is_ascii_alphanumeric();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        // A key starts at a word boundary with an uppercase letter.
        if b[i].is_ascii_uppercase() && (i == 0 || !alnum(b[i - 1])) {
            let mut j = i + 1;
            while j < b.len() && (b[j].is_ascii_uppercase() || b[j].is_ascii_digit()) {
                j += 1;
            }
            if j - i >= 2 && j < b.len() && b[j] == b'-' {
                let mut k = j + 1;
                while k < b.len() && b[k].is_ascii_digit() {
                    k += 1;
                }
                let boundary = k == b.len() || !alnum(b[k]);
                if k > j + 1 && boundary {
                    if !NOT_KEYS.contains(&&text[i..j]) {
                        let key = text[i..k].to_string();
                        if !out.contains(&key) {
                            out.push(key);
                        }
                    }
                    i = k;
                    continue;
                }
            }
            i = j;
            continue;
        }
        i += 1;
    }
    out
}

/// `#123` references in a text (not `foo#1`, not `#abc`), without duplicates.
pub fn detect_refs(text: &str) -> Vec<u32> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'#' && (i == 0 || !b[i - 1].is_ascii_alphanumeric()) {
            let mut k = i + 1;
            while k < b.len() && b[k].is_ascii_digit() {
                k += 1;
            }
            if k > i + 1
                && (k == b.len() || !b[k].is_ascii_alphanumeric())
                && let Ok(n) = text[i + 1..k].parse::<u32>()
                && !out.contains(&n)
            {
                out.push(n);
            }
            i = k.max(i + 1);
            continue;
        }
        i += 1;
    }
    out
}

/// `owner/repo` when a git remote URL points at GitHub.
pub fn github_slug(remote: &str) -> Option<String> {
    let r = remote.trim();
    let rest = if let Some(x) = r.strip_prefix("git@github.com:") {
        x
    } else if let Some(x) = r
        .strip_prefix("https://github.com/")
        .or_else(|| r.strip_prefix("http://github.com/"))
        .or_else(|| r.strip_prefix("ssh://git@github.com/"))
        .or_else(|| r.strip_prefix("git://github.com/"))
    {
        x
    } else {
        // https://user:token@github.com/o/r.git
        let i = r.find("@github.com/")?;
        &r[i + "@github.com/".len()..]
    };
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let mut it = rest.split('/');
    let (o, n) = (it.next()?, it.next()?);
    if o.is_empty() || n.is_empty() || it.next().is_some() {
        return None;
    }
    Some(format!("{o}/{n}"))
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Tracker URL templates from `$XDG_CONFIG_HOME/vela/config.toml`:
///
/// ```toml
/// [issues]
/// jira = "https://acme.atlassian.net/browse/{key}"
/// linear = "https://linear.app/acme/issue/{key}"
/// ```
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct IssueConfig {
    #[serde(default)]
    pub jira: Option<String>,
    #[serde(default)]
    pub linear: Option<String>,
}

#[derive(Deserialize, Default)]
struct ConfigFile {
    #[serde(default)]
    issues: IssueConfig,
}

impl IssueConfig {
    /// Parse the text of `config.toml`; anything unreadable gives the empty config.
    pub fn parse(text: &str) -> IssueConfig {
        toml::from_str::<ConfigFile>(text)
            .map(|c| c.issues)
            .unwrap_or_default()
    }

    /// Load `<dir>/config.toml`; a missing file gives the empty config.
    pub fn load_from(dir: &Path) -> IssueConfig {
        fs::read_to_string(dir.join("config.toml"))
            .map(|t| IssueConfig::parse(&t))
            .unwrap_or_default()
    }

    /// From the global config directory.
    pub fn from_env() -> IssueConfig {
        crate::paths::config_dir_from_env()
            .map(|d| IssueConfig::load_from(&d))
            .unwrap_or_default()
    }

    /// The link for a bare issue key. Without a template the URL stays empty.
    ///
    /// A key alone cannot tell which tracker owns it: Jira wins when both are
    /// configured, Linear is used when it is the only one.
    pub fn key_link(&self, key: &str, source: LinkSource) -> Link {
        let tpl = self
            .jira
            .as_deref()
            .map(|t| (Provider::Jira, t))
            .or_else(|| self.linear.as_deref().map(|t| (Provider::Linear, t)));
        match tpl {
            Some((provider, t)) => {
                let url = t.replace("{key}", key);
                Link {
                    id: link_id(&url, Some(key)),
                    kind: LinkKind::Issue,
                    provider,
                    url,
                    title: key.to_string(),
                    key: Some(key.to_string()),
                    source,
                    summary: None,
                }
            }
            None => Link {
                id: link_id("", Some(key)),
                kind: LinkKind::Issue,
                provider: Provider::Url,
                url: String::new(),
                title: format!("{key} (no tracker URL configured)"),
                key: Some(key.to_string()),
                source,
                summary: None,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Repo links
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RepoLink {
    url: String,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Deserialize, Default)]
struct RepoLinks {
    #[serde(default)]
    links: Vec<RepoLink>,
}

/// Parse `.vela/links.toml` (`[[links]]` tables with `url` and optional `title`).
pub fn parse_repo_links(text: &str) -> Vec<Link> {
    toml::from_str::<RepoLinks>(text)
        .unwrap_or_default()
        .links
        .into_iter()
        .filter(|l| is_http_url(&l.url))
        .map(|l| make_link(&l.url, l.title.as_deref(), LinkSource::Repo))
        .collect()
}

fn read_repo_links(repo: &SpaceRepo) -> Vec<Link> {
    for dir in [&repo.worktree, &repo.source] {
        if let Ok(text) = fs::read_to_string(Path::new(dir).join(".vela/links.toml")) {
            return parse_repo_links(&text);
        }
    }
    Vec::new()
}

// ---------------------------------------------------------------------------
// Detection and merge
// ---------------------------------------------------------------------------

fn origin_slug(dir: &Path) -> Option<String> {
    git(dir, &["remote", "get-url", "origin"])
        .ok()
        .and_then(|u| github_slug(&u))
}

/// Subjects of the commits on the space branch since its base.
fn commit_subjects(dir: &Path, base: &str) -> Vec<String> {
    git(dir, &["log", "--format=%s", &format!("{base}..HEAD")])
        .map(|o| o.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn same(a: &Link, b: &Link) -> bool {
    (!a.url.is_empty() && a.url == b.url) || (a.key.is_some() && a.key == b.key)
}

/// Keys and references found in the branch and the commits of every repo.
fn detect(space: &Space, cfg: &IssueConfig) -> Vec<Link> {
    let mut found: Vec<Link> = Vec::new();
    for k in detect_keys(&space.branch) {
        found.push(cfg.key_link(&k, LinkSource::Branch));
    }
    for r in &space.repos {
        let dir = Path::new(&r.worktree);
        let slug = origin_slug(dir);
        for subject in commit_subjects(dir, &r.base) {
            for k in detect_keys(&subject) {
                found.push(cfg.key_link(&k, LinkSource::Commit));
            }
            if let Some(slug) = &slug {
                for n in detect_refs(&subject) {
                    let url = format!("https://github.com/{slug}/issues/{n}");
                    let key = format!("{slug}#{n}");
                    found.push(Link {
                        id: link_id(&url, Some(&key)),
                        kind: LinkKind::Issue,
                        provider: Provider::Github,
                        url,
                        title: key.clone(),
                        key: Some(key),
                        source: LinkSource::Commit,
                        summary: None,
                    });
                }
            }
        }
    }
    merge(vec![found])
}

/// Merge lists in priority order, dropping a link that shares a url or a key with an earlier one.
pub fn merge(lists: Vec<Vec<Link>>) -> Vec<Link> {
    let mut out: Vec<Link> = Vec::new();
    for l in lists.into_iter().flatten() {
        if !out.iter().any(|o| same(o, &l)) {
            out.push(l);
        }
    }
    out
}

/// Every link of a space: stored, detected from the branch and commits, shared by the repos.
pub fn list_links(space: &Space, cfg: &IssueConfig) -> Result<Vec<Link>> {
    let repo_links: Vec<Link> = space.repos.iter().flat_map(read_repo_links).collect();
    Ok(merge(vec![
        space.links.clone(),
        detect(space, cfg),
        repo_links,
    ]))
}

/// Add a link typed by the user. Fails on anything but http(s); a duplicate is a no-op.
pub fn add_link(space: &mut Space, url: &str, title: Option<&str>) -> Result<Link> {
    add_link_from(space, url, title, LinkSource::Manual)
}

/// Like [`add_link`] with an explicit source (`Paste` for pasted URLs).
pub fn add_link_from(
    space: &mut Space,
    url: &str,
    title: Option<&str>,
    source: LinkSource,
) -> Result<Link> {
    if !is_http_url(url) {
        return Err(Error::Invalid(format!(
            "not an http(s) URL: {}",
            url.trim()
        )));
    }
    let link = make_link(url, title, source);
    if let Some(existing) = space.links.iter().find(|l| same(l, &link)) {
        return Ok(existing.clone());
    }
    space.links.push(link.clone());
    Ok(link)
}

/// Remove a stored link. Detected and repo links cannot be removed here.
pub fn remove_link(space: &mut Space, id: &str) -> Result<()> {
    let before = space.links.len();
    space.links.retain(|l| l.id != id);
    if space.links.len() == before {
        return Err(Error::LinkNotFound(id.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn space() -> Space {
        Space {
            id: "x".into(),
            name: "X".into(),
            color: "#fff".into(),
            branch: "feat/x".into(),
            repos: vec![],
            created_at: String::new(),
            window: None,
            archived: false,
            links: vec![],
        }
    }

    #[test]
    fn jira_issue() {
        let x = classify("https://acme.atlassian.net/browse/PAY-412");
        assert_eq!((x.kind, x.provider), (LinkKind::Issue, Provider::Jira));
        assert_eq!(x.key.as_deref(), Some("PAY-412"));
        assert_eq!(x.title, "PAY-412");
        let q = classify("https://acme.atlassian.net/browse/PAY-9?focusedCommentId=3");
        assert_eq!(q.key.as_deref(), Some("PAY-9"));
        let board = classify("https://acme.atlassian.net/jira/software/projects/PAY/boards/1");
        assert_eq!(board.kind, LinkKind::Other);
    }

    #[test]
    fn confluence_page() {
        let x = classify("https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Billing+design");
        assert_eq!((x.kind, x.provider), (LinkKind::Doc, Provider::Confluence));
        assert_eq!(x.title, "Billing design");
    }

    #[test]
    fn linear_issue() {
        let x = classify("https://linear.app/acme/issue/ENG-77/move-to-postgres-17");
        assert_eq!((x.kind, x.provider), (LinkKind::Issue, Provider::Linear));
        assert_eq!(x.key.as_deref(), Some("ENG-77"));
        assert_eq!(
            classify("https://linear.app/acme/team/ENG").kind,
            LinkKind::Other
        );
    }

    #[test]
    fn github_issue_and_pr() {
        let i = classify("https://github.com/acme/api/issues/12");
        assert_eq!((i.kind, i.provider), (LinkKind::Issue, Provider::Github));
        assert_eq!(i.key.as_deref(), Some("acme/api#12"));
        let p = classify("https://github.com/acme/api/pull/34/files");
        assert_eq!(p.kind, LinkKind::PullRequest);
        assert_eq!(p.key.as_deref(), Some("acme/api#34"));
        assert_eq!(
            classify("https://github.com/acme/api").kind,
            LinkKind::Other
        );
    }

    #[test]
    fn gitlab_merge_request_and_issue() {
        let m = classify("https://gitlab.com/acme/api/-/merge_requests/8");
        assert_eq!(
            (m.kind, m.provider),
            (LinkKind::PullRequest, Provider::Gitlab)
        );
        assert_eq!(m.key.as_deref(), Some("acme/api!8"));
        let i = classify("https://gitlab.example.com/grp/sub/proj/-/issues/3");
        assert_eq!((i.kind, i.provider), (LinkKind::Issue, Provider::Gitlab));
        assert_eq!(i.key.as_deref(), Some("grp/sub/proj#3"));
    }

    #[test]
    fn sentry_issue() {
        let x = classify("https://acme.sentry.io/issues/45678/?project=1");
        assert_eq!((x.kind, x.provider), (LinkKind::Error, Provider::Sentry));
        assert_eq!(x.key.as_deref(), Some("45678"));
        let y = classify("https://sentry.io/organizations/acme/issues/99/");
        assert_eq!(y.key.as_deref(), Some("99"));
    }

    #[test]
    fn figma_notion_google() {
        let f = classify("https://www.figma.com/design/AbC123/Checkout-flow?node-id=1");
        assert_eq!((f.kind, f.provider), (LinkKind::Design, Provider::Figma));
        assert_eq!(f.title, "Checkout flow");
        assert_eq!(
            classify("https://www.figma.com/file/AbC/x").kind,
            LinkKind::Design
        );
        let n = classify(
            "https://www.notion.so/acme/Billing-migration-0123456789abcdef0123456789abcdef",
        );
        assert_eq!((n.kind, n.provider), (LinkKind::Doc, Provider::Notion));
        assert_eq!(n.title, "Billing migration");
        let g = classify("https://docs.google.com/document/d/abc/edit");
        assert_eq!((g.kind, g.provider), (LinkKind::Doc, Provider::GoogleDocs));
        assert_eq!(
            classify("https://docs.google.com/spreadsheets/d/abc").title,
            "Google Sheet"
        );
    }

    #[test]
    fn grafana_datadog_slack() {
        let g = classify("https://grafana.acme.io/d/abc123/payments-latency?orgId=1");
        assert_eq!(
            (g.kind, g.provider),
            (LinkKind::Dashboard, Provider::Grafana)
        );
        assert_eq!(g.title, "payments latency");
        let d = classify("https://app.datadoghq.com/dashboard/abc-def");
        assert_eq!(
            (d.kind, d.provider),
            (LinkKind::Dashboard, Provider::Datadog)
        );
        let s = classify("https://acme.slack.com/archives/C012/p1700000000");
        assert_eq!((s.kind, s.provider), (LinkKind::Chat, Provider::Slack));
        assert_eq!(
            classify("https://acme.slack.com/messages/x").kind,
            LinkKind::Other
        );
    }

    #[test]
    fn environments() {
        for u in [
            "https://staging.acme.dev/checkout",
            "https://preview.acme.dev",
            "https://acme-git-feat-x.vercel.app/",
            "http://localhost:5173/",
            "http://127.0.0.1:3000",
        ] {
            let x = classify(u);
            assert_eq!(x.kind, LinkKind::Environment, "{u}");
            assert_eq!(x.provider, Provider::Url);
        }
        assert_eq!(
            classify("https://staging.acme.dev/x").title,
            "Staging acme.dev"
        );
        assert_eq!(classify("http://localhost:5173/").title, "Local");
    }

    #[test]
    fn other_and_garbage() {
        let x = classify("https://example.com/some/page");
        assert_eq!((x.kind, x.provider), (LinkKind::Other, Provider::Url));
        assert_eq!(x.title, "example.com/…/page");
        assert_eq!(classify("https://example.com").title, "example.com");
        assert_eq!(classify("not a url").kind, LinkKind::Other);
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(is_http_url("HTTPS://Example.com"));
        assert_eq!(
            classify("https://user:pw@GitHub.com/a/b/issues/1").provider,
            Provider::Github
        );
    }

    #[test]
    fn keys_in_text() {
        assert_eq!(detect_keys("feat/PAY-412-refunds"), vec!["PAY-412"]);
        assert_eq!(
            detect_keys("fix PAY-1 and ENG2-30, again PAY-1"),
            vec!["PAY-1", "ENG2-30"]
        );
        assert!(detect_keys("utf-8 UTF-8 SHA-256 ISO-8601 HTTP-2").is_empty());
        assert!(detect_keys("pay-412").is_empty());
        assert!(detect_keys("aPAY-412 PAY-412a P-1").is_empty());
        assert_eq!(detect_keys("(PAY-7)"), vec!["PAY-7"]);
    }

    #[test]
    fn refs_in_text() {
        assert_eq!(detect_refs("fix #12 and #34, #12"), vec![12, 34]);
        assert!(detect_refs("a#1 #abc ##").is_empty());
        assert_eq!(detect_refs("(#5)"), vec![5]);
    }

    #[test]
    fn github_remotes() {
        for u in [
            "git@github.com:acme/api.git",
            "https://github.com/acme/api",
            "https://github.com/acme/api.git",
            "ssh://git@github.com/acme/api.git",
            "https://user:tok@github.com/acme/api.git",
        ] {
            assert_eq!(github_slug(u).as_deref(), Some("acme/api"), "{u}");
        }
        assert_eq!(github_slug("git@gitlab.com:acme/api.git"), None);
        assert_eq!(github_slug("/home/me/repo"), None);
    }

    #[test]
    fn config_templates() {
        let cfg = IssueConfig::parse(
            "[issues]\njira = \"https://acme.atlassian.net/browse/{key}\"\nlinear = \"https://linear.app/acme/issue/{key}\"\n",
        );
        let l = cfg.key_link("PAY-1", LinkSource::Branch);
        assert_eq!(l.url, "https://acme.atlassian.net/browse/PAY-1");
        assert_eq!(l.provider, Provider::Jira);
        let only_linear =
            IssueConfig::parse("[issues]\nlinear = \"https://linear.app/a/issue/{key}\"");
        assert_eq!(
            only_linear.key_link("EN-1", LinkSource::Branch).provider,
            Provider::Linear
        );
        let none = IssueConfig::default().key_link("PAY-1", LinkSource::Branch);
        assert_eq!(none.url, "");
        assert!(none.title.contains("no tracker URL"));
        assert_eq!(IssueConfig::parse("garbage ["), IssueConfig::default());
    }

    #[test]
    fn repo_links_file() {
        let l = parse_repo_links(
            "[[links]]\nurl = \"https://grafana.acme.io/d/x/api\"\ntitle = \"API dashboard\"\n\n[[links]]\nurl = \"https://acme.dev/runbook\"\n\n[[links]]\nurl = \"ftp://nope\"\n",
        );
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].title, "API dashboard");
        assert_eq!(l[0].source, LinkSource::Repo);
        assert_eq!(l[0].kind, LinkKind::Dashboard);
        assert_eq!(l[1].title, "acme.dev/runbook");
    }

    #[test]
    fn merge_dedupes_by_url_or_key() {
        let cfg =
            IssueConfig::parse("[issues]\njira = \"https://acme.atlassian.net/browse/{key}\"");
        let stored = make_link(
            "https://acme.atlassian.net/browse/PAY-1",
            Some("Mine"),
            LinkSource::Manual,
        );
        let detected = cfg.key_link("PAY-1", LinkSource::Branch);
        let other = make_link("https://acme.dev/a", None, LinkSource::Repo);
        let dup = make_link("https://acme.dev/a", Some("again"), LinkSource::Repo);
        // A key detected without a tracker URL still merges with a stored link of the same key.
        let keyonly = IssueConfig::default().key_link("PAY-1", LinkSource::Commit);
        let m = merge(vec![
            vec![stored],
            vec![detected, keyonly],
            vec![other, dup],
        ]);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].title, "Mine");
    }

    #[test]
    fn add_and_remove() {
        let mut s = space();
        let l = add_link(&mut s, "https://linear.app/a/issue/ENG-1/x", None).unwrap();
        assert_eq!(l.title, "ENG-1");
        assert_eq!(l.source, LinkSource::Manual);
        add_link(&mut s, "https://linear.app/a/issue/ENG-1/x", Some("other")).unwrap();
        assert_eq!(s.links.len(), 1);
        assert!(add_link(&mut s, "javascript:alert(1)", None).is_err());
        assert!(add_link(&mut s, "ftp://x.y/z", None).is_err());
        let p = add_link_from(
            &mut s,
            "https://acme.dev/z",
            Some("  Z  "),
            LinkSource::Paste,
        )
        .unwrap();
        assert_eq!(p.title, "Z");
        remove_link(&mut s, &l.id).unwrap();
        assert_eq!(s.links.len(), 1);
        assert!(matches!(
            remove_link(&mut s, "nope"),
            Err(Error::LinkNotFound(_))
        ));
    }

    #[test]
    fn link_json_shape() {
        let l = make_link(
            "https://acme.atlassian.net/browse/PAY-1",
            None,
            LinkSource::Paste,
        );
        let v = serde_json::to_value(&l).unwrap();
        assert_eq!(v["kind"], "issue");
        assert_eq!(v["provider"], "jira");
        assert_eq!(v["source"], "paste");
        let pr = make_link("https://github.com/a/b/pull/1", None, LinkSource::Manual);
        assert_eq!(serde_json::to_value(&pr).unwrap()["kind"], "pullRequest");
        let g = make_link(
            "https://docs.google.com/document/d/x",
            None,
            LinkSource::Manual,
        );
        assert_eq!(serde_json::to_value(&g).unwrap()["provider"], "googleDocs");
    }
}
