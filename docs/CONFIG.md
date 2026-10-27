# Configuration

Vela reads `config.toml` files in three layers. The later layer wins, key by key.

| Layer | File | Committed |
| --- | --- | --- |
| global | `$XDG_CONFIG_HOME/vela/config.toml` (default `~/.config/vela/config.toml`) | no |
| repo, shared | `<repo>/.vela/config.toml` | yes, the whole team gets it |
| repo, local | `VELA_HOME/repos/<repo-name>.toml` | no, yours alone |

Tables merge. Arrays replace, except `[[checks.custom]]`, whose entries merge by `id` (a later layer can redefine one check and leave the others). A layer that is not valid TOML, or has a value of the wrong type, is ignored whole and reported as a warning. Keys Vela does not know are kept and reported as warnings, never as errors: a newer config still loads in an older Vela.

The Rust side is `vela_core::config`: `load_repo_config(vela, repo_dir, repo_name)` gives the typed `Config`, the files looked at, the warnings, and `explain()`, which lists every effective value with the layer it comes from (`default`, `global`, `repo (shared)`, `repo (local)`). That is what a settings screen will show.

The toggles in the UI write the repo local layer (`config::set_local_value`).

## `[checks]`

Checks are commands run in your worktree on the staged set: git hooks, tests, lint, type checks, your own scripts. They are shown in the Review view.

```toml
[checks]
auto = true                            # run when the staged set changes
timeout_secs = 300                     # per check
skip_hooks_on_commit_if_passed = true  # see below

[[checks.custom]]
id = "secrets"                         # required, unique in the repo
name = "Secret scan"                   # shown in the panel, defaults to the id
run = "gitleaks protect --staged"      # required, shell command (`{files}` = staged paths)
kind = "custom"                        # hook | test | lint | types | custom
when = "staged"                        # staged: runs with `auto`; manual: only when asked
optional = false                       # true: off until you turn it on

[checks.detected.cargo-test]
enabled = true                         # switch a detected (or custom) check on or off
```

| Key | Default | Meaning |
| --- | --- | --- |
| `checks.auto` | `true` | Rerun the enabled checks (debounced 500 ms) when the index changes. |
| `checks.timeout_secs` | `300` | A check still running after this is killed (the whole process group) and fails. Timeouts are not cached. |
| `checks.skip_hooks_on_commit_if_passed` | `true` | If every enabled hook check passed on the exact index tree being committed, commit with `--no-verify` and add the trailer `Vela-Checks: <ids> passed on <short tree>`. Otherwise git runs its hooks as usual. |
| `checks.custom` | none | Your own checks (fields above). |
| `checks.detected.<id>.enabled` | per check | Force a check on or off. Works for custom checks too. |

### What is detected

Per repo worktree. Hooks, lint and type checks are on; tests are `optional` and off until you turn them on.

| Found | Check id | Command | Kind |
| --- | --- | --- | --- |
| `.pre-commit-config.yaml` | `pre-commit` | `pre-commit run --files <staged paths>` | hook |
| `lefthook.yml` | `lefthook` | `lefthook run pre-commit` | hook |
| `.husky/pre-commit` | `husky` | `sh .husky/pre-commit` | hook |
| none of the above, but an executable `pre-commit` in the hooks dir (`core.hooksPath`, else `git rev-parse --git-common-dir`/hooks) | `git-hook` | that file | hook |
| `package.json` `scripts.test` | `test` | `<pm> test` | test |
| `package.json` `scripts.lint` / `typecheck` / `check` | `lint` / `typecheck` / `check` | `<pm> run <script>` | lint / types / types |
| `Cargo.toml` | `clippy`, `cargo-test` | `cargo clippy -- -D warnings`, `cargo test` | lint, test |
| `pytest.ini`, or pytest in `pyproject.toml` / `setup.cfg` | `pytest` | `pytest` | test |
| `ruff.toml`, `.ruff.toml`, `[tool.ruff]` | `ruff` | `ruff check` | lint |
| `go.mod` | `go-test` | `go test ./...` | test |
| `Makefile` with a `test:` target | `make-test` | `make test` | test |

`<pm>` is `pnpm`, `yarn`, `bun` or `npm`, from the lockfile. The `npm init` placeholder test script is ignored. A check whose tool is not on `PATH` shows as "missing tool" and does not run.

### Caching

A result is cached in memory by repo, check id, command and `git write-tree` of the index (plus `HEAD` for tests). The same staged set gives the result back at once, flagged `cached`. Staging or unstaging anything, even a single hunk, changes the tree and so runs the check again. Timeouts are never cached.

### Unknown keys

```toml
[checks]
autorun = true   # warning: unknown key `checks.autorun`
```

## `[issues]`

Tracker URL templates for issue keys found in branches and commits.

```toml
[issues]
jira = "https://acme.atlassian.net/browse/{key}"
linear = "https://linear.app/acme/issue/{key}"
```

Repo links (prod URL, runbook, dashboard) live next to it in `<repo>/.vela/links.toml`.

## `[agents]`

Which harness and model each role uses. See `docs/HARNESS.md`.

```toml
[agents.tiers.claude]
high = "opus"
medium = "sonnet"
low = "haiku"

[agents.tiers.codex]
high = "<model>"

[agents.effort.claude]
high = "max"                             # reasoning effort of the tier

[agents.roles]
planner = { tier = "high", harness = "claude" }
tester = { harness = "opencode" }        # either key can be left out

[agents.transport]
opencode = "cli"                         # acp or cli
```

| Key | Default | Meaning |
| --- | --- | --- |
| `agents.tiers.<harness>.<high\|medium\|low>` | none | Model passed to that harness for the tier (`--model` / `-m`). Not set: no model flag, the harness picks its own default. opencode wants `provider/model`. |
| `agents.effort.<harness>.<high\|medium\|low>` | none | Reasoning effort of the tier: `--effort` (Claude Code), `model_reasoning_effort` (Codex), `--variant` / `thought_level` (opencode). Not set: the harness default. |
| `agents.transport.<harness>` | ACP when installed | `acp` or `cli`. See `docs/HARNESS.md`. |
| `agents.roles.<role>.tier` | planner, reviewer, debugger, product, security `high`; developer `medium`; tester `low` | Tier of the role. |
| `agents.roles.<role>.harness` | `claude` | Harness of the role. If it is not installed, the first installed one (claude, codex, opencode) is used. |

The "Agent tiers" sheet of the app (Ctrl K, "Agent tiers") edits `agents.tiers` and `agents.effort` in the global layer; clearing a field removes the key.

A request can override both: the composer's harness picker (`Shift Tab`) and tier (`Ctrl ↑` / `Ctrl ↓`). An agent asks for the layers of the first repo of its space.
