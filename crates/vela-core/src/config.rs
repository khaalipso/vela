//! Layered configuration. See `docs/CONFIG.md` for the schema.
//!
//! Three layers, the later one wins:
//!
//! 1. global: `$XDG_CONFIG_HOME/vela/config.toml`
//! 2. repo, shared: `<repo>/.vela/config.toml` (committed)
//! 3. repo, local: `VELA_HOME/repos/<repo-name>.toml` (not committed)
//!
//! Layers are merged table by table. Arrays replace, except `checks.custom`,
//! whose entries merge by `id`. Keys that the schema does not know are kept
//! (see [`Config::extra`]) and reported as warnings, never as errors.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use toml::{Table, Value};

use crate::Vela;
use crate::error::Result;
use crate::model::{CheckKind, CheckWhen};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Layer {
    /// Not set in any file: the built in default.
    Default,
    Global,
    Shared,
    Local,
}

impl Layer {
    pub fn label(self) -> &'static str {
        match self {
            Layer::Default => "default",
            Layer::Global => "global",
            Layer::Shared => "repo (shared)",
            Layer::Local => "repo (local)",
        }
    }
}

fn yes() -> bool {
    true
}
fn timeout() -> u64 {
    300
}

/// `[[checks.custom]]`: a shell command run in the repo worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomCheck {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// Shell command. `{files}` expands to the staged paths of the repo.
    pub run: String,
    #[serde(default = "custom_kind")]
    pub kind: CheckKind,
    #[serde(default = "staged")]
    pub when: CheckWhen,
    /// Optional checks are off until turned on.
    #[serde(default)]
    pub optional: bool,
}

fn custom_kind() -> CheckKind {
    CheckKind::Custom
}
fn staged() -> CheckWhen {
    CheckWhen::Staged
}

/// `[checks.detected.<id>]`: switch a detected (or custom) check on or off.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckOverride {
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ChecksConfig {
    /// Run the checks when the staged set changes.
    pub auto: bool,
    pub timeout_secs: u64,
    /// Commit with `--no-verify` when the hook checks passed on the exact tree.
    pub skip_hooks_on_commit_if_passed: bool,
    pub custom: Vec<CustomCheck>,
    pub detected: BTreeMap<String, CheckOverride>,
}

impl Default for ChecksConfig {
    fn default() -> Self {
        ChecksConfig {
            auto: yes(),
            timeout_secs: timeout(),
            skip_hooks_on_commit_if_passed: yes(),
            custom: Vec::new(),
            detected: BTreeMap::new(),
        }
    }
}

/// `[issues]`: tracker URL templates (read by `links`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct IssuesConfig {
    pub jira: Option<String>,
    pub linear: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub checks: ChecksConfig,
    pub issues: IssuesConfig,
    /// Top level keys the schema does not know, kept as written.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// One effective value and the layer it comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Explained {
    /// Dotted path, e.g. `checks.auto` or `checks.detected.cargo-test.enabled`.
    pub key: String,
    pub value: String,
    pub layer: Layer,
    pub known: bool,
}

/// A config file that was looked at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerFile {
    pub layer: Layer,
    pub path: Option<PathBuf>,
    pub found: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadedConfig {
    pub config: Config,
    pub files: Vec<LayerFile>,
    /// Unknown keys, bad syntax, wrong types. Never fatal.
    pub warnings: Vec<String>,
    origins: BTreeMap<String, (Layer, Value)>,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

pub fn global_file(dir: &Path) -> PathBuf {
    dir.join("config.toml")
}

pub fn shared_file(repo_dir: &Path) -> PathBuf {
    repo_dir.join(".vela/config.toml")
}

pub fn local_file(vela: &Vela, repo_name: &str) -> PathBuf {
    vela.home.join("repos").join(format!("{repo_name}.toml"))
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CUSTOM_KEYS: [&str; 6] = ["id", "name", "run", "kind", "when", "optional"];

/// Is this dotted leaf path part of the schema?
fn is_known(path: &str) -> bool {
    let parts: Vec<&str> = path.split('.').collect();
    matches!(
        parts.as_slice(),
        [
            "checks",
            "auto" | "timeout_secs" | "skip_hooks_on_commit_if_passed"
        ] | ["checks", "custom", _]
            | ["checks", "detected", _, "enabled"]
            | ["issues", "jira" | "linear"]
    )
}

fn valid_custom(t: &Table) -> bool {
    t.get("id")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
        && t.get("run")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
}

/// Flatten a layer into `(dotted path, value)` leaves. Entries of `checks.custom`
/// are one leaf each, keyed by their id.
fn leaves(table: &Table, prefix: &str, out: &mut Vec<(String, Value)>) {
    for (k, v) in table {
        let path = if prefix.is_empty() {
            k.clone()
        } else {
            format!("{prefix}.{k}")
        };
        match v {
            Value::Table(t) => leaves(t, &path, out),
            Value::Array(items) if path == "checks.custom" => {
                for it in items {
                    if let Value::Table(t) = it
                        && let Some(id) = t.get("id").and_then(Value::as_str)
                    {
                        out.push((format!("{path}.{id}"), it.clone()));
                    }
                }
            }
            _ => out.push((path, v.clone())),
        }
    }
}

fn describe(v: &Value) -> String {
    match v {
        Value::Table(_) | Value::Array(_) => serde_json::to_string(v).unwrap_or_default(),
        other => other.to_string(),
    }
}

fn defaults_explained() -> Vec<(&'static str, String)> {
    let d = ChecksConfig::default();
    vec![
        ("checks.auto", d.auto.to_string()),
        ("checks.timeout_secs", d.timeout_secs.to_string()),
        (
            "checks.skip_hooks_on_commit_if_passed",
            d.skip_hooks_on_commit_if_passed.to_string(),
        ),
    ]
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/// Parse one layer. Syntax errors and type errors drop the whole layer with a warning;
/// a custom check without `id` or `run` drops only that entry.
fn read_layer(layer: Layer, path: &Path, warnings: &mut Vec<String>) -> Option<Table> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            warnings.push(format!("{}: cannot read: {e}", path.display()));
            return None;
        }
    };
    let mut table = match text.parse::<Table>() {
        Ok(t) => t,
        Err(e) => {
            warnings.push(format!(
                "{}: ignored, invalid TOML: {}",
                path.display(),
                e.message()
            ));
            return None;
        }
    };
    if let Some(Value::Array(items)) = table.get_mut("checks").and_then(|c| c.get_mut("custom")) {
        let before = items.len();
        items.retain(|it| it.as_table().is_some_and(valid_custom));
        if items.len() != before {
            warnings.push(format!(
                "{}: a [[checks.custom]] entry needs `id` and `run`, ignored",
                path.display()
            ));
        }
    }
    if let Err(e) = Value::Table(table.clone()).try_into::<Config>() {
        warnings.push(format!(
            "{}: ignored, {} ({})",
            path.display(),
            e.message(),
            layer.label()
        ));
        return None;
    }
    let mut flat = Vec::new();
    leaves(&table, "", &mut flat);
    for (key, v) in &flat {
        if !is_known(key) {
            warnings.push(format!("{}: unknown key `{key}`", path.display()));
        } else if key.starts_with("checks.custom.")
            && let Value::Table(t) = v
        {
            for k in t.keys().filter(|k| !CUSTOM_KEYS.contains(&k.as_str())) {
                warnings.push(format!("{}: unknown key `{key}.{k}`", path.display()));
            }
        }
    }
    Some(table)
}

/// Merge `over` into `base`: tables recurse, `checks.custom` merges by id, the rest is replaced.
fn merge(base: &mut Table, over: Table, prefix: &str) {
    for (k, v) in over {
        let path = if prefix.is_empty() {
            k.clone()
        } else {
            format!("{prefix}.{k}")
        };
        match (base.get_mut(&k), v) {
            (Some(Value::Table(b)), Value::Table(o)) => merge(b, o, &path),
            (Some(Value::Array(b)), Value::Array(o)) if path == "checks.custom" => {
                for item in o {
                    let id = item.get("id").and_then(Value::as_str).map(str::to_string);
                    let at = b.iter().position(|x| {
                        id.is_some() && x.get("id").and_then(Value::as_str) == id.as_deref()
                    });
                    match at {
                        Some(i) => b[i] = item,
                        None => b.push(item),
                    }
                }
            }
            (_, v) => {
                base.insert(k, v);
            }
        }
    }
}

/// Load and merge the layers in order (later wins). Missing files are fine.
pub fn load_layers(layers: &[(Layer, PathBuf)]) -> LoadedConfig {
    let mut warnings = Vec::new();
    let mut files = Vec::new();
    let mut merged = Table::new();
    let mut origins: BTreeMap<String, (Layer, Value)> = BTreeMap::new();
    for (layer, path) in layers {
        let table = read_layer(*layer, path, &mut warnings);
        files.push(LayerFile {
            layer: *layer,
            path: Some(path.clone()),
            found: table.is_some(),
        });
        if let Some(t) = table {
            let mut flat = Vec::new();
            leaves(&t, "", &mut flat);
            for (k, v) in flat {
                origins.insert(k, (*layer, v));
            }
            merge(&mut merged, t, "");
        }
    }
    let config = Value::Table(merged)
        .try_into::<Config>()
        .unwrap_or_default();
    LoadedConfig {
        config,
        files,
        warnings,
        origins,
    }
}

/// Like [`load_repo_config`] with an explicit global config directory (None skips the layer).
pub fn load_repo_config_in(
    global_dir: Option<&Path>,
    vela: &Vela,
    repo_dir: &Path,
    repo_name: &str,
) -> LoadedConfig {
    let mut layers = Vec::new();
    if let Some(d) = global_dir {
        layers.push((Layer::Global, global_file(d)));
    }
    layers.push((Layer::Shared, shared_file(repo_dir)));
    layers.push((Layer::Local, local_file(vela, repo_name)));
    load_layers(&layers)
}

/// The effective config of a repo. `repo_source` is the repo directory that holds
/// `.vela/config.toml` (a clone or a worktree of it). The global layer comes from the environment.
pub fn load_repo_config(vela: &Vela, repo_source: &Path, repo_name: &str) -> LoadedConfig {
    load_repo_config_in(
        crate::paths::config_dir_from_env().as_deref(),
        vela,
        repo_source,
        repo_name,
    )
}

impl LoadedConfig {
    /// For every effective value, the layer it came from. Defaults come first-class too, so a
    /// settings screen can show every key.
    pub fn explain(&self) -> Vec<Explained> {
        let mut out: Vec<Explained> = Vec::new();
        for (key, value) in defaults_explained() {
            if !self.origins.contains_key(key) {
                out.push(Explained {
                    key: key.to_string(),
                    value,
                    layer: Layer::Default,
                    known: true,
                });
            }
        }
        for (key, (layer, v)) in &self.origins {
            out.push(Explained {
                key: key.clone(),
                value: describe(v),
                layer: *layer,
                known: is_known(key),
            });
        }
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }

    /// The layer that sets `key`, `Default` when none does.
    pub fn layer_of(&self, key: &str) -> Layer {
        self.origins.get(key).map_or(Layer::Default, |(l, _)| *l)
    }
}

// ---------------------------------------------------------------------------
// Writing the local layer
// ---------------------------------------------------------------------------

/// Set one value in the repo local layer, creating the file and tables as needed.
/// Other keys, known or not, are kept (comments are not).
pub fn set_local_value(vela: &Vela, repo_name: &str, path: &[&str], value: Value) -> Result<()> {
    let file = local_file(vela, repo_name);
    let mut root: Table = match fs::read_to_string(&file) {
        Ok(t) => t.parse().unwrap_or_default(),
        Err(_) => Table::new(),
    };
    let Some((last, parents)) = path.split_last() else {
        return Ok(());
    };
    let mut cur = &mut root;
    for p in parents {
        let entry = cur
            .entry((*p).to_string())
            .or_insert_with(|| Value::Table(Table::new()));
        if !entry.is_table() {
            *entry = Value::Table(Table::new());
        }
        cur = entry.as_table_mut().expect("table");
    }
    cur.insert((*last).to_string(), value);
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&file, toml::to_string_pretty(&root)?)?;
    Ok(())
}

/// Turn a check on or off in the repo local layer.
pub fn set_check_enabled(
    vela: &Vela,
    repo_name: &str,
    check_id: &str,
    enabled: bool,
) -> Result<()> {
    set_local_value(
        vela,
        repo_name,
        &["checks", "detected", check_id, "enabled"],
        Value::Boolean(enabled),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn write(p: &Path, text: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn defaults_without_files() {
        let t = tmp();
        let vela = Vela::new(t.path().join("home"));
        let c = load_repo_config_in(None, &vela, &t.path().join("repo"), "api");
        assert!(c.config.checks.auto);
        assert_eq!(c.config.checks.timeout_secs, 300);
        assert!(c.config.checks.skip_hooks_on_commit_if_passed);
        assert!(c.warnings.is_empty());
        assert!(c.explain().iter().all(|e| e.layer == Layer::Default));
    }

    #[test]
    fn later_layer_wins_and_explain_names_it() {
        let t = tmp();
        let vela = Vela::new(t.path().join("home"));
        let global = t.path().join("g");
        let repo = t.path().join("repo");
        write(
            &global_file(&global),
            "[checks]\nauto = false\ntimeout_secs = 10\n",
        );
        write(&shared_file(&repo), "[checks]\ntimeout_secs = 60\n");
        write(
            &local_file(&vela, "api"),
            "[checks]\nskip_hooks_on_commit_if_passed = false\n",
        );
        let c = load_repo_config_in(Some(&global), &vela, &repo, "api");
        assert!(!c.config.checks.auto);
        assert_eq!(c.config.checks.timeout_secs, 60);
        assert!(!c.config.checks.skip_hooks_on_commit_if_passed);
        assert_eq!(c.layer_of("checks.auto"), Layer::Global);
        assert_eq!(c.layer_of("checks.timeout_secs"), Layer::Shared);
        assert_eq!(
            c.layer_of("checks.skip_hooks_on_commit_if_passed"),
            Layer::Local
        );
        let ex = c.explain();
        let find = |k: &str| ex.iter().find(|e| e.key == k).unwrap();
        assert_eq!(find("checks.timeout_secs").value, "60");
        assert_eq!(find("checks.timeout_secs").layer, Layer::Shared);
        assert_eq!(c.files.len(), 3);
        assert!(c.files.iter().all(|f| f.found));
    }

    #[test]
    fn unknown_keys_are_kept_and_warned() {
        let t = tmp();
        let vela = Vela::new(t.path().join("home"));
        let repo = t.path().join("repo");
        write(
            &shared_file(&repo),
            "theme = \"dark\"\n[checks]\nauto = true\nspeed = 3\n[checks.detected.x]\nenabled = false\nwhy = 1\n",
        );
        let c = load_repo_config_in(None, &vela, &repo, "api");
        assert!(c.config.checks.auto);
        assert_eq!(
            c.config.extra.get("theme").and_then(Value::as_str),
            Some("dark")
        );
        let w = c.warnings.join("\n");
        assert!(w.contains("unknown key `theme`"), "{w}");
        assert!(w.contains("unknown key `checks.speed`"), "{w}");
        assert!(w.contains("unknown key `checks.detected.x.why`"), "{w}");
        assert!(!w.contains("checks.auto"));
        let ex = c.explain();
        assert!(ex.iter().any(|e| e.key == "theme" && !e.known));
    }

    #[test]
    fn bad_layers_are_skipped_not_fatal() {
        let t = tmp();
        let vela = Vela::new(t.path().join("home"));
        let repo = t.path().join("repo");
        let global = t.path().join("g");
        write(&global_file(&global), "[checks\nauto = ");
        write(&shared_file(&repo), "[checks]\nauto = \"yes\"\n");
        write(
            &local_file(&vela, "api"),
            "[checks]\ntimeout_secs = 5\n[[checks.custom]]\nname = \"no id\"\n",
        );
        let c = load_repo_config_in(Some(&global), &vela, &repo, "api");
        assert_eq!(c.config.checks.timeout_secs, 5);
        assert!(c.config.checks.auto);
        assert_eq!(c.warnings.len(), 3, "{:?}", c.warnings);
    }

    #[test]
    fn custom_checks_merge_by_id() {
        let t = tmp();
        let vela = Vela::new(t.path().join("home"));
        let repo = t.path().join("repo");
        write(
            &shared_file(&repo),
            "[[checks.custom]]\nid = \"a\"\nrun = \"echo a\"\n[[checks.custom]]\nid = \"b\"\nrun = \"echo b\"\nkind = \"lint\"\n",
        );
        write(
            &local_file(&vela, "api"),
            "[[checks.custom]]\nid = \"a\"\nrun = \"echo A\"\nwhen = \"manual\"\n",
        );
        let c = load_repo_config_in(None, &vela, &repo, "api");
        let cu = &c.config.checks.custom;
        assert_eq!(cu.len(), 2);
        assert_eq!(cu[0].run, "echo A");
        assert_eq!(cu[0].when, CheckWhen::Manual);
        assert_eq!(cu[1].kind, CheckKind::Lint);
        assert_eq!(c.layer_of("checks.custom.a"), Layer::Local);
        assert_eq!(c.layer_of("checks.custom.b"), Layer::Shared);
    }

    #[test]
    fn writing_the_local_layer_keeps_other_keys() {
        let t = tmp();
        let vela = Vela::new(t.path().join("home"));
        write(
            &local_file(&vela, "api"),
            "mystery = 1\n[checks]\nauto = false\n",
        );
        set_check_enabled(&vela, "api", "cargo-test", true).unwrap();
        set_check_enabled(&vela, "api", "cargo-test", false).unwrap();
        let c = load_repo_config_in(None, &vela, &t.path().join("repo"), "api");
        assert!(!c.config.checks.auto);
        assert_eq!(c.config.checks.detected["cargo-test"].enabled, Some(false));
        assert!(c.config.extra.contains_key("mystery"));
    }
}
