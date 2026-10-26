# Vela

An editor built around tasks, for people who code with agents.

Arc replaced tabs with spaces. Vela replaces the open folder with the **space**: one task, the repos it touches, one worktree per repo, the agents working on it, its containers and runtimes. You switch tasks, not folders.

## Principles

1. **One focused surface.** A space shows one view at a time: Code, Review or Agents. Nothing is docked unless you ask for it.
2. **The IDE tells you what is next.** The "Up next" island always holds the single most useful action (answer an agent, review proposals, commit). `Enter` does it. `Shift Enter` jumps to the next space waiting for you.
3. **Keyboard first.** Every action has a key. Hints at the bottom change with the view. `Ctrl K` reaches everything.
4. **You stay the author.** Agents never write in your worktree. They propose hunks from their own worktrees; you accept, reject or edit each one. Typing by hand always works.
5. **Plain git underneath.** Spaces are branches and standard `git worktree`s. Uninstall Vela and nothing is lost.
6. **One AI config, many tools.** Instructions, MCP servers, skills and agent roles are set in layers (global, space, repo, folder) and written out to `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `opencode.json`, `.codex/config.toml`, `crush.json`.

## Model

The types in `crates/vela-core/src/model.rs` are the contract. The UI mirrors them in `ui/src/lib/types.ts`.

- **Space**: id (slug), name, color, branch, repos, window.
- **SpaceRepo**: source clone, worktree created by Vela, base ref.
- **FileChange**: staged side and unstaged side, like VS Code.
- **Hunk**: stable id (hash of repo, path, content), lines, origin (`You` or `Agent`), state.
- **Agent**: role, tool (claude, codex, opencode, crush), its worktrees, status.
- **StackItem**: runtimes from `mise.toml` / `.tool-versions`, containers from `compose.yml`.
- **UpNext**: computed by the core.

## Storage

- `VELA_HOME` (default `$XDG_DATA_HOME/vela`, else `~/.local/share/vela`).
- `VELA_HOME/spaces/<id>.toml`: one file per space.
- `VELA_HOME/worktrees/<space>/<repo>`: the user's worktree for that repo.
- `VELA_HOME/worktrees/<space>/.agents/<agent>/<repo>`: an agent's worktree, on branch `<space-branch>--<agent>`.
- Global AI config: `$XDG_CONFIG_HOME/vela/` (default `~/.config/vela/`).

## How proposals work

An agent works in its own worktree. Its proposals are the diff between its worktree and the user's worktree for the same repo. Accepting a hunk applies that patch to the user's worktree (`git apply`), then stages it. Rejecting records the hunk id so it is not shown again. Editing accepts, then opens the lines in the editor.

## Commit gate

Before a commit, run in parallel on the staged diff only: reviewer agent (non interactive CLI call), tests touched by the diff, lint, secret scan, repo rules. Results are cached per hunk id. One commit is made per repo with the same message; push goes to the same branch name everywhere. Override needs a written reason, stored in the commit trailer `Vela-Override:`.

## Keys

| Key | Action |
| --- | --- |
| `Ctrl K` | Command bar: spaces, files, actions |
| `Enter` / `Shift Enter` | Up next / next space waiting |
| `[` `]`, `Alt 1..9` | Previous, next space / jump to space |
| `1` `2` `3` | Code, Review, Agents |
| `J` `K` | Next, previous proposal |
| `Y` `N` `E` `U` | Accept, reject, accept and edit, undo |
| `F` | Ask the author to fix the reviewer note |
| `B` | Changes drawer (staged, changed by you, proposed) |
| `S` | Stack and containers |
| `@` | Ask an agent (Tab cycles the role) |
| `C` | Commit gate |
| `W` | Open the space in its own window |
| `?` | All shortcuts |

Single letter keys only act when focus is not in a text field. `Esc` leaves the field.

## Architecture

- `crates/vela-core`: Rust library. Git through the `git` CLI (worktrees, hooks and user config behave exactly as in the terminal). Space store, status, diff parsing, hunk staging, proposals, stack detection, AI config layering.
- `crates/vela-cli`: `vela` binary over the core. Every feature is testable headless through it.
- `app/` (later): Tauri 2 shell exposing the core as commands.
- `ui/`: Svelte 5 + TypeScript + Vite, CodeMirror 6 for editing, xterm.js for agent terminals. Runs against a mock backend in the browser and against Tauri in the app. `ui/reference/prototype.html` is the interaction reference.

Why not a VS Code fork: its workbench is built around one workspace folder, which is exactly what Vela replaces; a fork means monthly rebases of a huge codebase and no access to the Microsoft marketplace anyway. Why not from scratch: an editor core, LSP client and terminal are years of work. CodeMirror 6 and xterm.js give us those, and all the effort goes into the shell.

## Milestones

- **M0 core**: spaces (create with worktrees, list, archive), status, diff to hunks, stage and unstage a hunk, multi repo commit. CLI. Tests on temporary repos.
- **M1 shell**: UI from the prototype on a mock backend; then the Tauri app wired to the core.
- **M2 agents**: launch agent CLIs in a PTY in their own worktree, proposals, accept and reject.
- **M3 stack and config**: mise and compose detection, containers per worktree, AI config layers and writers.
- **M4 gate**: commit gate with cache.

## Testing

Everything is tested headless: `cargo test`, `pnpm -C ui test`, `pnpm -C ui build`. Nothing drives the screen.
