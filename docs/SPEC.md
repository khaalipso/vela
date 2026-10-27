# Vela

An editor built around tasks, for people who code with agents.

Arc replaced tabs with spaces. Vela replaces the open folder with the **space**: one task, the repos it touches, one worktree per repo, the agents working on it, its containers and runtimes. You switch tasks, not folders.

## Principles

1. **One focused surface.** A space shows one view at a time: Code, Review or Agents. Nothing is docked unless you ask for it.
2. **The IDE tells you what is next.** The "Up next" island always holds the single most useful action (answer an agent, review proposals, commit). `Enter` does it. `Shift Enter` jumps to the next space waiting for you.
3. **Keyboard first.** Every action has a key. Hints at the bottom change with the view. `Cmd/Ctrl T` reaches everything, `Cmd/Ctrl K` asks an agent. On macOS the hints show ⌘ ⇧ ⌥.
4. **You stay the author.** Agents never write in your worktree. They propose hunks from their own worktrees; you accept, reject or edit each one. Typing by hand always works.
5. **Plain git underneath.** Spaces are branches and standard `git worktree`s. Uninstall Vela and nothing is lost.
6. **One AI config, many tools.** Instructions, MCP servers, skills and agent roles are set in layers (global, space, repo, folder) and written out to `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `opencode.json`, `.codex/config.toml`, `crush.json`.

## Model

The types in `crates/vela-core/src/model.rs` are the contract. The UI mirrors them in `ui/src/lib/types.ts`.

- **Space**: id (slug), name, color, branch, repos, window, links (added by hand or pasted; detected and repo links are computed).
- **Link**: kind, provider, url, title, key, source (manual, branch, commit, paste, repo). Issue keys come from the branch and commit subjects, tracker URLs from `$XDG_CONFIG_HOME/vela/config.toml` (`[issues] jira = "https://acme.atlassian.net/browse/{key}"`), shared repo links from `<repo>/.vela/links.toml`.
- **CommitPlan / CommitGroup**: proposed commits for the staged hunks (type, scope, breaking, subject, body, footers, hunk ids), rules from commitlint or history.
- **SpaceRepo**: source clone, worktree created by Vela, base ref.
- **FileChange**: staged side and unstaged side, like VS Code.
- **Hunk**: stable id (hash of repo, path, content), lines, origin (`You` or `Agent`), state.
- **Agent**: role, harness (`tool`: claude, codex, opencode), model, tier, session, its worktrees, status (working, waiting, done, failed, interrupted), summary, last message, plan, question, usage.
- **StackItem**: runtimes from `mise.toml` / `.tool-versions`, containers from `compose.yml`.
- **UpNext**: computed by the core.

## Storage

- `VELA_HOME` (default `$XDG_DATA_HOME/vela`, else `~/.local/share/vela`).
- `VELA_HOME/spaces/<id>.toml`: one file per space.
- `VELA_HOME/worktrees/<space>/<repo>`: the user's worktree for that repo.
- `VELA_HOME/worktrees/<space>/.agents/<agent>/<repo>`: an agent's worktree, on branch `<space-branch>--<agent>`, created from the commit the space branch is on (your uncommitted changes are not copied).
- `VELA_HOME/spaces/<id>.agents.json`: the agents of a space; `VELA_HOME/spaces/<id>.agents/<agent>.jsonl`: the event log of each agent.
- Global AI config: `$XDG_CONFIG_HOME/vela/` (default `~/.config/vela/`).

## How proposals work

An agent works in its own worktree. Its proposals are what it changed since the commit it started from (committed or not) that is not already in the user's worktree; comparing the two worktrees directly would offer to undo the user's own uncommitted edits. Accepting a hunk applies that patch to the user's worktree (`git apply`), then stages it. Rejecting records the hunk id so it is not shown again. Editing accepts, then opens the lines in the editor.

## Review view and checks

The Review view has three zones: files (Staged first and big, then Not staged, then Proposed by agents), the diff of the selected file with every hunk and its state, and the Checks panel (hooks, lint, types, optional tests, your own scripts) with live status and logs. Checks run in your worktree on the staged set, are cached by the tree of the index, and rerun by themselves when the staged set changes (`checks.auto`). Detection, config layers and keys: `docs/CONFIG.md`. Keys in the view: `J` `K` files, `Space` stage or unstage the file, `Shift A` / `Shift U` all, `Enter` focus the diff, `Tab` / `Shift Tab` hunks, `Y` stage / accept, `U` unstage, `N` reject a proposal (your own edits are never discarded), `R` run all checks, `Shift J` / `Shift K` pick a check, `Shift R` run it, `O` its log.

The composer's gate lists the results of these checks (a failing one needs an override). If every enabled hook check passed on the exact index tree and `checks.skip_hooks_on_commit_if_passed` is on, the commit runs with `--no-verify` and carries `Vela-Checks: <ids> passed on <short tree>`.

## Terminal, preview, colors, notifications

- **Terminal panel** (`T` or `Ctrl \``): shells in a pseudo terminal (`portable-pty`, `$SHELL`) started in a worktree of the space, shown with xterm.js under the current view. One tab per shell, one more with `Ctrl Shift \`` or the `+ <repo>` buttons, resizable. Each space has its own terminals.
- **Markdown**: `.md` files open rendered (marked, sanitized with DOMPurify); `V` shows the source in the editor; relative links open the file, web links the browser.
- **Syntax colors** for TypeScript, JavaScript (and JSX), JSON, HTML, CSS, SCSS, Less, Vue, Svelte, Python, Rust, Go, Java, Kotlin, C, C++, C#, PHP, Ruby, Swift, Lua, shell, TOML, INI and `.env`, YAML, SQL, Markdown (with code blocks), XML, Dockerfile and more. Each language is loaded the first time a file of it opens (`lib/languages.ts`).
- **Repo colors**: each repo of a space has a soft color in the family of the space color (analogous hues 32° apart, calm saturation, `lib/colors.ts`). Editor tabs, top bar chips, the file tree and the review groups use it.
- **Desktop notifications** when an agent asks a question, is done or fails, while no Vela window has the focus.

## Branches

A space has one branch, the same name in every repo. When you create a space you can type it, or leave it empty for the naming pattern (`[spaces] branch`, `feat/{slug}` by default, edited in Settings, Branches), and pick the base it starts from (each repo's current branch by default). A name that already exists is used as it is: a local branch gets the worktree, a remote one (`origin/<branch>`, a PR or a teammate's branch) gets a local branch that tracks it. A branch checked out in another worktree is refused with the path of that checkout. A failed creation removes only the branches it made.

The branch chip in the top bar renames the branch (`git branch -m` in every repo, the agents' `<branch>--<agent>` branches too; worktrees stay where they are), copies its name, pushes it (`git push -u origin`) and opens the pull requests. From the CLI: `vela space new --branch <b> --base <ref>`, `vela space rename-branch <space> <b>`.

## Agents view

A conversation per agent: the list on the left (at work first, `J` `K` to move), the chat on the right. The chat shows your requests, the agent's full answers rendered as Markdown, its tool calls grouped between answers (click to unfold, with the files it edited), its plan, its questions with their answer buttons, and the end of each run. It updates live. The field at the bottom answers a question or gives a finished agent more work in the same session and worktree. "Edit and rerun" opens the composer with the request; "Review its changes" goes to the Review.

## Your changes in the code view

Each line you changed has a bar in the gutter, between the line numbers and the code: amber when not staged, green when staged, a red wedge where lines were deleted; striped bars are changed lines, plain ones added. Lines you type show at once. Clicking a bar opens the change in place, under its lines: before and after, Stage or Unstage, Revert (with Undo in the notification, which puts the file back as it was), Copy original. A strip above the file counts the changes, moves between them (`Ctrl Alt ↓` `Ctrl Alt ↑`) and stages, unstages or reverts the whole file. Reverting a hunk is `discard_hunk`: `git apply -R` on the worktree, and on the index too for a staged hunk, checked first so nothing is half applied.

## Pull requests

The Pull requests view (`4`) shows, for each repo of the space, the PR of the space branch through the GitHub CLI (`gh`, logged in): state, review decision, reviews, review comments on lines with their replies, the conversation, and the checks. A line comment opens the file at its line or goes to a developer agent ("Ask an agent to fix", on the remembered harness); a review that requests changes too. Comments are posted with `gh pr comment`. A repo without a PR offers to push the branch and open one (`gh pr create --fill`, or as a draft); its URL is added to the links. `R` refreshes; a fetch is reused for a minute. The switch shows how many PRs want something from you (changes requested or a failing check).

## Commit gate

Before a commit, run in parallel on the staged diff only: reviewer agent (non interactive CLI call), tests touched by the diff, lint, secret scan, repo rules. Results are cached per hunk id. One commit is made per repo with the same message; push goes to the same branch name everywhere. Override needs a written reason, stored in the commit trailer `Vela-Override:`.

## Keys

| Key | Action |
| --- | --- |
| `Ctrl T` | Command bar: spaces, files, actions |
| `Ctrl K`, `@` | Ask an agent (`Ctrl K` again closes) |
| `Ctrl B` | Hide the spaces bar; it floats in when the pointer touches the left edge |
| `Ctrl Alt ↓` `Ctrl Alt ↑` | Code view: next, previous change of yours, opened in place |
| `Enter` / `Shift Enter` | Up next / next space waiting |
| `[` `]`, `Alt 1..9` | Previous, next space / jump to space |
| `1` `2` `3` `4` | Code, Review, Agents, Pull requests |
| `J` `K` | Next, previous proposal |
| `Y` `N` `E` `U` | Accept, reject, accept and edit, undo |
| `F` | Ask the author to fix the reviewer note (`Shift Y` resolves it) |
| `V` | Code view: Markdown preview or source. Review: before and after side by side, or unified |
| `Ctrl F` | Find (and replace) in the open file, or in the Markdown preview |
| `T`, `Ctrl \`` | Terminal panel; `Ctrl Shift \`` opens one more |
| `B` | Changes drawer (staged, changed by you, proposed) |
| `S` | Stack and containers |
| `@` | Ask an agent (Tab cycles the role) |
| `C` | Commit composer: gate checks, then one card per commit (`T` type, `!` breaking, `1`-`9` move a hunk, `G` split, `M` merge, `Ctrl Enter` commit all) |
| `L` | Links of the space (paste a URL anywhere to add one) |
| `W` | Open the space in its own window |
| `?` | All shortcuts |

## Right-click menus

Every place has a context menu (`Menu` key or `Shift F10` on the focused item): file tree rows (file, folder, repo), editor tabs, the editor, review file rows and hunks, spaces in the rail (with an Archived section), repo chips in the top bar, links. Rows of the tree also have a `⋯` button. The same actions are listed under "Here" in the command bar for the current place, and shortcuts shown in menus are resolved through the keymap. Writes are guarded like `write_file`: inside a space worktree only, never `.git`. Delete goes to the system trash (`trash` crate); where there is none the UI asks and deletes for good. Discard restores the file from HEAD (from the index when part of it is staged); an untracked file needs an explicit confirm. Archiving a space only hides it; removing one stops its agents, deletes its worktrees, the worktrees and branches of its agents (`<space-branch>--<agent>`, their work only ever reached you as proposals), their logs and notes, and keeps the space branch when it has unmerged commits. Terminal: `$TERMINAL`, else `xdg-terminal-exec`, else a common terminal.

Single letter keys only act when focus is not in a text field. `Esc` leaves the field.

## Architecture

- `crates/vela-core`: Rust library. Git through the `git` CLI (worktrees, hooks and user config behave exactly as in the terminal). Space store, status, diff parsing, hunk staging, proposals, stack detection, AI config layering.
- `crates/vela-cli`: `vela` binary over the core. Every feature is testable headless through it.
- `app/`: Tauri 2 shell exposing the core as commands (`commands.rs` plain functions, `tauri_cmds.rs` wrappers, `watch.rs` file watcher emitting `vela://changed`). Run with `pnpm -C ui tauri dev`.
- `ui/`: Svelte 5 + TypeScript + Vite, CodeMirror 6 for editing, xterm.js for agent terminals. Runs against a mock backend in the browser and against Tauri in the app. `ui/reference/prototype.html` is the interaction reference.

Why not a VS Code fork: its workbench is built around one workspace folder, which is exactly what Vela replaces; a fork means monthly rebases of a huge codebase and no access to the Microsoft marketplace anyway. Why not from scratch: an editor core, LSP client and terminal are years of work. CodeMirror 6 and xterm.js give us those, and all the effort goes into the shell.

## Milestones

- **M0 core**: spaces (create with worktrees, list, archive), status, diff to hunks, stage and unstage a hunk, multi repo commit. CLI. Tests on temporary repos.
- **M1 shell**: UI from the prototype on a mock backend; then the Tauri app wired to the core.
- **M2 agents**: drive Claude Code, Codex and opencode non interactively (`docs/HARNESS.md`), each in its own worktree; proposals, accept and reject; questions as Up next; usage and cost per space.
- **M3 stack and config**: mise and compose detection, containers per worktree, AI config layers and writers.
- **M4 gate**: commit gate with cache.

## Testing

Everything is tested headless: `cargo test`, `pnpm -C ui test`, `pnpm -C ui build`. Nothing drives the screen.
