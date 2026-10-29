<p align="center">
  <img src="assets/icon.svg" width="96" alt="Vela icon">
</p>

<h1 align="center">Vela</h1>

<p align="center">An editor built around tasks, for people who code with agents.</p>

Arc replaced tabs with spaces. Vela replaces the open folder with the **space**: one task, the
repos it touches (your own clones, where they are), and the agents working on it. You switch
tasks, not folders.

Vela does not ship its own coding agent. It drives the ones you already use (Claude Code, Codex,
opencode) and adds what sits around them: worktrees, review, checks, commits, links, terminals.
Agents work on a copy of your files, in their own worktree; when a run ends, Vela merges their
work into your files (an agent resolves its own conflicts with your edits). You review everything
once, before you commit.

## Features

- **Spaces**: a task with its repos and optionally its ticket (`PAY-412`). A space works in your
  clones as they are, on the branch they are on, so any other editor sees the same files; name a
  branch and the repos switch to it. Add a repo, or a folder of repos, with "+ repo"; × removes
  one from the space without touching it. Uninstall Vela and nothing is lost.
- **Page** (<kbd>0</kbd>): free Markdown per space, for links, notes, commands. A URL pasted
  anywhere goes on it; the links Vela finds (ticket, issue keys in branches and commits, repo
  links) show on top. Kept by Vela (`VELA_HOME/spaces/<id>.md`), never in a repo.
- **Agents** through their own CLIs, or ACP when the tool has an ACP server (`opencode acp`):
  developer, tester, debugger write in their own worktree; planner, reviewer, product and security
  only read. Questions land in the *Up next* island and as a desktop notification.
- **Tiers, not models**: each request runs at `high`, `medium` or `low`; the *Agent tiers* sheet
  sets the model and the reasoning effort of each tier, per tool, and the *Vela* model, the small
  model Vela runs for its own tasks: it labels the conversations so the search of the Agents view finds them.
- **Agents you can follow**: what each one does right now, how long it has been quiet, a
  warning with "Stop and ask where it is" when it says nothing for 5 minutes, and its session id
  one click away.
- **Review** before you commit, like a pull request: the tree of files on the left, every diff on
  the right, one under the other (unified or side by side, <kbd>V</kbd>); <kbd>J</kbd> <kbd>K</kbd>
  or scrolling go from file to file. The work of the agents is already in your files: there is
  no separate review of agent changes. Edit, revert one change, then <kbd>Space</kbd> stages the
  file.
  Checks (hooks, lint, types, tests) run on the staged set and are cached by tree.
- **Reviewer notes**: findings of the reviewer and security agents show on the file they target;
  <kbd>F</kbd> sends one back to its author for a fix, <kbd>Shift</kbd>+<kbd>Y</kbd> resolves it.
- **Commit composer** (<kbd>C</kbd>): conventional commits inferred from the diff, split
  suggestions, the ticket in the footer, one repo at a time (<kbd>R</kbd> switches).
- **Git view** (<kbd>4</kbd>): the commit graph of each repo, the branch against its base and its
  upstream, what is not committed yet, and the pull requests.
- **Editor** on CodeMirror 6 with find and replace (<kbd>Ctrl</kbd>+<kbd>F</kbd>), a Markdown
  preview, quick open (<kbd>Ctrl</kbd>+<kbd>P</kbd>) and a file tree with fuzzy filter.
- **Terminal panel** (<kbd>T</kbd> or <kbd>Ctrl</kbd>+<kbd>`</kbd>): shells in the worktrees of
  the space, one set per space.
- **Keyboard first**: every action has a key, <kbd>Ctrl</kbd>+<kbd>K</kbd> reaches everything,
  <kbd>?</kbd> lists the shortcuts.

## Requirements

- Linux (x86_64 or arm64) or macOS 11+
- `git`, `make`, and the toolchain of `mise.toml` (Rust, Node.js, pnpm). With
  [mise](https://mise.jdx.dev) installed, `make install` sets it up by itself.
- macOS: the Xcode command line tools (`xcode-select --install`).
- Linux: WebKitGTK 4.1 development files. `make install` names the packages for Arch,
  Debian/Ubuntu and Fedora when they are missing.
- At least one agent CLI on the `PATH` for the agent features: `claude`, `codex` or `opencode`.

## Installation

```sh
git clone https://github.com/khaalipso/vela.git
cd vela
make install   # builds Vela and installs the app and the `vela` command (no root needed)
make launch    # or start Vela from your app launcher, Spotlight or Launchpad
```

| Command | Description |
|---|---|
| `make install` | Build and install the app (`~/Applications/Vela.app` on macOS, `~/.local/bin/vela-app` and a desktop entry on Linux) and the `vela` command in `~/.local/bin` |
| `make launch` | Start the installed app |
| `make update` | Pull the repository and install again |
| `make uninstall` | Remove the app and the command; spaces and settings are kept |
| `make dev` | Run from the sources with hot reload |
| `make try` | Run on throwaway demo repos, nothing else is touched |
| `make test` | Rust and interface tests, type check and build, all headless |

The first build takes a few minutes (Rust release build).

On macOS the app is not notarized: the install script removes the quarantine flag and signs it ad
hoc so it opens normally. When started from the Dock or Finder, Vela reads the `PATH` of your login
shell, so the agent CLIs and your tools are found as in a terminal.

## Where things live

| What | Where |
|---|---|
| Spaces, worktrees, agent logs | `~/.local/share/vela` (`VELA_HOME`) |
| Global settings | `~/.config/vela/config.toml` |
| Repo settings, shared with the team | `<repo>/.vela/config.toml` |
| Repos offered in the new space sheet | under `~/Work` (`VELA_REPO_ROOTS`), plus any folder you add |

## Documentation

- [docs/SPEC.md](docs/SPEC.md): the model, the views, the keys, the architecture.
- [docs/HARNESS.md](docs/HARNESS.md): how agents are driven (ACP, CLIs, tiers, roles, notes).
- [docs/CONFIG.md](docs/CONFIG.md): every setting and its layers.
- [docs/FEATURES.md](docs/FEATURES.md): what Vela changes for a developer, and what comes next.

## Development

```sh
make dev     # the app with hot reload
make test    # everything headless
pnpm -C ui dev   # the interface alone on a mock backend, in a browser
```

The code: `crates/vela-core` (spaces, git, diff, checks, config, commit plans), `crates/vela-agents`
(drivers, ACP, worktrees, proposals, notes), `crates/vela-cli` (the `vela` command), `app/` (Tauri 2
shell), `ui/` (Svelte 5, CodeMirror 6, xterm.js).

## License

[MIT](LICENSE)
