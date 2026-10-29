# Vela

An editor built around tasks, for people who code with agents.

Arc replaced tabs with spaces. Vela replaces the open folder with the **space**: one task, the repos it touches, one worktree per repo, the agents working on it, its containers and runtimes. You switch tasks, not folders.

## Principles

1. **One focused surface.** A space shows one view at a time: Code (`1`), Agents (`2`), Review (`3`) or Git (`4`). Nothing is docked unless you ask for it.
2. **The IDE tells you what is next.** The "Up next" island always holds the single most useful action (answer an agent, review proposals, commit). `Enter` does it. `Shift Enter` jumps to the next space waiting for you.
3. **Keyboard first.** Every action has a key. Hints at the bottom change with the view. `Cmd/Ctrl T` reaches everything, `Cmd/Ctrl K` asks an agent. On macOS the hints show ⌘ ⇧ ⌥.
4. **You stay the author.** Agents never write in your worktree. They work on a copy of your files; you review what they changed file by file, edit it if you want, and accept or reject it. Typing by hand always works.
5. **Plain git underneath.** Spaces are branches and standard `git worktree`s. Uninstall Vela and nothing is lost.
6. **One AI config, many tools.** Instructions, MCP servers, skills and agent roles are set in layers (global, space, repo, folder) and written out to `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `opencode.json`, `.codex/config.toml`, `crush.json`.

## Model

The types in `crates/vela-core/src/model.rs` are the contract. The UI mirrors them in `ui/src/lib/types.ts`.

- **Space**: id (slug), name, color, branch (the one it was created with, the default of a repo added later), repos, window, links (added by hand or pasted; detected and repo links are computed), ticket (the issue of the task).
- **Link**: kind, provider, url, title, key, source (manual, branch, commit, paste, repo). Issue keys come from the branch and commit subjects, tracker URLs from `$XDG_CONFIG_HOME/vela/config.toml` (`[issues] jira = "https://acme.atlassian.net/browse/{key}"`), shared repo links from `<repo>/.vela/links.toml`.
- **CommitPlan / CommitGroup**: proposed commits for the staged hunks (type, scope, breaking, subject, body, footers, hunk ids), rules from commitlint or history.
- **SpaceRepo**: source clone, worktree created by Vela, base ref, its own branch.
- **FileChange**: staged side and unstaged side, like VS Code.
- **Hunk**: stable id (hash of repo, path, content), lines, origin (`You` or `Agent`), state.
- **Agent**: role, harness (`tool`: claude, codex, opencode), model, tier, session, its worktrees, status (working, waiting, done, failed, interrupted), summary, last message, plan, question, usage, activity (what it does now), last event (when it last said anything), labels.
- **StackItem**: runtimes from `mise.toml` / `.tool-versions`, containers from `compose.yml`.
- **UpNext**: computed by the core.

## Storage

- `VELA_HOME` (default `$XDG_DATA_HOME/vela`, else `~/.local/share/vela`).
- `VELA_HOME/spaces/<id>.toml`: one file per space.
- `VELA_HOME/worktrees/<space>/<repo>`: the user's worktree for that repo.
- `VELA_HOME/worktrees/<space>/.agents/<agent>/<repo>`: an agent's worktree, on branch `<repo-branch>--<agent>`, created from the commit the space branch is on, then filled with your files as they are (uncommitted edits and new files included).
- `VELA_HOME/spaces/<id>.agents.json`: the agents of a space; `VELA_HOME/spaces/<id>.agents/<agent>.jsonl`: the event log of each agent.
- Global AI config: `$XDG_CONFIG_HOME/vela/` (default `~/.config/vela/`).

## How proposals work

An agent works in its own worktree, which starts as a copy of your files (uncommitted edits included), so it builds on what you see. Its proposals are what it changed since that starting point (committed or not) that is not already in your worktree; comparing the two worktrees directly would offer to undo the edits you made since.

Accepting a file is a three-way merge (`git merge-file`): the base is the file as the agent found it, "theirs" is the base with the changes it still proposes, "mine" is your file now. Your edits next to the agent's are kept; lines you both changed come back as conflict markers, shown in the Review with "Keep yours", "Take the agent's" and "Keep both" on each. A file with markers left is never written or staged. Rejecting records the ids of the file's proposals so they are not shown again. When an agent runs again and everything it proposed was decided, its worktree takes your files as they are and that becomes its new base.

## Review view and checks

The Review view lists each changed file once, as a tree like the files of a pull request (the order and compacted folders of the file tree, `buildTree`): a file is **to review** (an agent proposal or an edit of yours waits in it) or **accepted** (✓, everything in it is staged and goes in the commit). Each row shows who changed the file (agent role chips, "You", "Conflict", "Edited") and its size; a folder row counts the files to review in it and accepts them all. "All files" adds the files without changes, which open in the editor. The spaces bar is hidden in this view. The selected file shows what its agents said they did, then the whole file as a diff (CodeMirror merge view, `lib/mergeview.ts`): unified or side by side (`V`), syntax colors, unchanged runs folded. For a file with agent changes the diff goes from your file to what accepting writes ("Agent changes"), or from the last commit ("All since commit"). The "after" side is editable: type in it, revert one change ("↶ Revert"), resolve conflicts in place; accepting writes exactly what it shows (`accept_file`). `Space` or `Y` accepts the file, stages it and moves to the next file to review; `U` (or `Space` on an accepted file) takes it back. `Shift A` accepts every file waiting and leaves the ones with conflicts, saying which. `N` rejects what the agents propose in the file; your own edits are never thrown away there. `Tab` / `Shift Tab` move between the changes, `Enter` puts the cursor in the diff, `E` opens the file in the editor, `M` or a click on a line number comments that line. The lists move at once and git catches up behind; reloads that overlap are merged. Accepted proposals are remembered (`<space>.accepted.json`): they are never offered again, even when you change those lines afterwards. When an agent starts a new run and everything it proposed was decided, its base moves to what it has, so the run offers only what it changes next. The Checks panel sits under the list; the file tree drawer is hidden in this view.

Comments: click a line number (or `M` on a hunk) to comment a line. The comment goes to a reviewer, who answers without changing anything, or to a developer, who answers and changes the code (the agent that wrote the hunk when it can be resumed, else a new one; its changes come back as proposals). The answer shows in a thread under the hunk; answering in the thread is a follow up of the same agent. Threads are kept in `VELA_HOME/spaces/<space>.comments.json`, the answers are read back from the agent's log.

Agents that write (developer, debugger, tester) work in their own worktree, so they get their permissions without asking: Claude Code runs with `acceptEdits` and edits and shell commands allowed, opencode with `OPENCODE_PERMISSION` allowing edits and commands, ACP permission requests are granted, Codex keeps `workspace-write`. Read only roles are unchanged.

`Ctrl W` (`Cmd W`) closes the file tab of the editor, never the window: on macOS the menu bar has no "Close Window" item.

The composer's gate lists the results of these checks (a failing one needs an override). If every enabled hook check passed on the exact index tree and `checks.skip_hooks_on_commit_if_passed` is on, the commit runs with `--no-verify` and carries `Vela-Checks: <ids> passed on <short tree>`.

## Terminal, preview, colors, notifications

- **Terminal panel** (`T` or `Ctrl \``): shells in a pseudo terminal (`portable-pty`, `$SHELL`) started in a worktree of the space, shown with xterm.js under the current view. One tab per shell, one more with `Ctrl Shift \`` or the `+ <repo>` buttons, resizable. Each space has its own terminals.
- **Markdown**: `.md` files open rendered (marked, sanitized with DOMPurify); `V` shows the source in the editor; relative links open the file, web links the browser.
- **Syntax colors** for TypeScript, JavaScript (and JSX), JSON, HTML, CSS, SCSS, Less, Vue, Svelte, Python, Rust, Go, Java, Kotlin, C, C++, C#, PHP, Ruby, Swift, Lua, shell, TOML, INI and `.env`, YAML, SQL, Markdown (with code blocks), XML, Dockerfile and more. Each language is loaded the first time a file of it opens (`lib/languages.ts`).
- **Repo colors**: each repo of a space has a soft color in the family of the space color (analogous hues 32° apart, calm saturation, `lib/colors.ts`). Editor tabs, top bar chips, the file tree and the review groups use it.
- **Desktop notifications** when an agent asks a question, is done or fails, while no Vela window has the focus.

## Branches

Each repo of a space has its own branch. When you create a space you type one branch for all of them, or leave it empty for the naming pattern (`[spaces] branch`, `feat/{slug}` by default, `{ticket}` takes the ticket, edited in Settings, Branches), give some repos a branch of their own, and pick the base it starts from (each repo's current branch by default). A repo added later takes the branch the space was created with, or the one you type. A name that already exists is used as it is: a local branch gets the worktree, a remote one (`origin/<branch>`, a PR or a teammate's branch) gets a local branch that tracks it. A branch checked out in another worktree is refused with the path of that checkout. A failed creation removes only the branches it made.

The branch chip in the top bar shows the branch when every repo is on it, else "n branches" and each repo chip shows its own. Its menu renames (`git branch -m`, the agents' `<branch>--<agent>` branches too; worktrees stay where they are) in every repo or in one, copies, pushes (`git push -u origin`) and opens the pull requests; the menu of a repo chip does the same for that repo. From the CLI: `vela space new --branch <b> --base <ref> --ticket <key>`, `vela space rename-branch <space> <b> [--repo <repo>]`, `vela space ticket <space> <key>`.

## Ticket

A space can have a ticket (`PAY-412`, or the URL of the issue, from which the key is taken): the "+ ticket" chip of the top bar sets it, a click changes it. It is the `Refs:` footer of the commits (alone, instead of the keys found in the branch and the commits), the first label of its agents, the issue link of the space, `{ticket}` in the branch pattern, and the agents read it in their context.

## Git view

The Git view (`4`) shows, for each repo, the space branch against its base (`origin/HEAD`, else `main` or `master`): commits ahead and behind, what it changes (`+added −removed in n files`), whether it is pushed, the files not committed and the stashes; then the commit graph of the branch and its base (`git log --graph`, drawn as lanes in SVG, the commits of the space highlighted, branches and tags as labels, a click copies a hash). The pull requests of the space follow (below).

## Agents view

A conversation per agent: the list on the left (at work first, `J` `K` to move), the chat on the right. A search field above the list finds a conversation by its labels, request, summary, role, harness or session id, every word must match; the labels of the space under it filter in one click. Labels come from the Vela model, the small model Vela runs for its own tasks (`[agents.vela]`: on by default, its own harness and model in the Vela row of the Agent tiers sheet), which reads the request and gives one or two words; the ticket of the space comes first. The header of the chat shows the session id of the harness, a click copies it. While an agent works, the chat and the list show what it does now (its last tool call, "Bash: pnpm test") and, after 30 seconds of silence, for how long it has said nothing. After 5 minutes it is flagged as maybe stuck, with "Stop and ask where it is" (cancels the run and resumes the same session with a message asking what blocked it) and Cancel. The chat shows your requests, the agent's full answers rendered as Markdown, its tool calls grouped between answers (click to unfold, with the files it edited), its plan, its questions with their answer buttons, and the end of each run. It updates live. The field at the bottom answers a question or gives a finished agent more work in the same session and worktree. While the agent works you can still write: the message is queued ("Sends when it stops", removable) and sent as soon as its run ends. "Edit and rerun" opens the composer with the request. Under the header, the files the agent changed that still wait for you, with their size: a click opens that file in the Review. The tier of each agent (high, medium, low) shows in the list. Up next sits in the bar of this view, so it never covers the chat; the file tree drawer is hidden here.

## Your changes in the code view

Each line you changed has a bar in the gutter, between the line numbers and the code: amber when not staged, green when staged, a red wedge where lines were deleted; striped bars are changed lines, plain ones added. Lines you type show at once. Clicking a bar opens the change in place, under its lines: before and after, Stage or Unstage, Revert (with Undo in the notification, which puts the file back as it was), Copy original. A strip above the file counts the changes, moves between them (`Ctrl Alt ↓` `Ctrl Alt ↑`) and stages, unstages or reverts the whole file. Reverting a hunk is `discard_hunk`: `git apply -R` on the worktree, and on the index too for a staged hunk, checked first so nothing is half applied.

## Pull requests

Under the history, the Git view shows, for each repo of the space, the PR of the space branch through the GitHub CLI (`gh`, logged in): state, review decision, reviews, review comments on lines with their replies, the conversation, and the checks. A line comment opens the file at its line or goes to a developer agent ("Ask an agent to fix", on the remembered harness); a review that requests changes too. Comments are posted with `gh pr comment`. A repo without a PR offers to push the branch and open one (`gh pr create --fill`, or as a draft); its URL is added to the links. `R` refreshes; a fetch is reused for a minute. The switch shows how many PRs want something from you (changes requested or a failing check).

## Commit gate

Before a commit, run in parallel on the staged diff only: reviewer agent (non interactive CLI call), tests touched by the diff, lint, secret scan, repo rules. Results are cached per hunk id. A commit is for one repo: the composer opens on the repo of the open file (else the first with staged changes), a tab per repo with staged changes switches (`R`), and only that repo is committed; the others keep their staged changes for the next `C`. Override needs a written reason, stored in the commit trailer `Vela-Override:`.

## Keys

| Key | Action |
| --- | --- |
| `Ctrl T` | Command bar: spaces, files, actions |
| `Ctrl K`, `@` | Ask an agent (`Ctrl K` again closes) |
| `Ctrl B` | Hide the spaces bar; it floats in when the pointer touches the left edge |
| `Ctrl Alt ↓` `Ctrl Alt ↑` | Code view: next, previous change of yours, opened in place |
| `Enter` / `Shift Enter` | Up next / next space waiting |
| `[` `]`, `Alt 1..9` | Previous, next space / jump to space |
| `1` `2` `3` `4` | Code, Agents, Review, Git |
| `J` `K` | Next, previous proposal (Review: file) |
| `Y` `N` `E` `U` | Accept, reject, accept and edit, undo (Review: accept the file, reject its agent changes, open it, back to review) |
| `F` | Ask the author to fix the reviewer note (`Shift Y` resolves it) |
| `M` | Review: comment the hunk under the cursor, a reviewer or a developer agent answers |
| `Ctrl W` | Close the file tab of the editor |
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

Every place has a context menu (`Menu` key or `Shift F10` on the focused item): file tree rows (file, folder, repo), editor tabs, the editor, review file rows and hunks, spaces in the rail (with an Archived section), repo chips in the top bar, links. Rows of the tree also have a `⋯` button. The same actions are listed under "Here" in the command bar for the current place, and shortcuts shown in menus are resolved through the keymap. Writes are guarded like `write_file`: inside a space worktree only, never `.git`. Delete goes to the system trash (`trash` crate); where there is none the UI asks and deletes for good. The tree shows what is on disk: a deleted file leaves it (the Review lists the deletion), and a file staged as new then deleted leaves the index too. Discard restores the file from HEAD (from the index when part of it is staged); an untracked file needs an explicit confirm. Archiving a space only hides it; removing one stops its agents, deletes its worktrees, the worktrees and branches of its agents (`<space-branch>--<agent>`, their work only ever reached you as proposals), their logs and notes, and keeps the space branch when it has unmerged commits. Terminal: `$TERMINAL`, else `xdg-terminal-exec`, else a common terminal.

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
