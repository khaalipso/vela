# What Vela changes for a developer

Ranked by how much time they give back. Each feature names what you do today and what Vela does instead.

## Tier 1: the reasons to switch

### 1. Context card: everything about the task, in the space
Today: the Jira ticket is in one tab, the design doc in another, the staging URL in your history, the Sentry issue in Slack.

Vela: each space has a context card with its links: issue (Jira, Linear, GitHub), PRs, docs, Figma, Sentry issue, Grafana dashboard, Slack thread, staging and prod URLs.
- Links are detected automatically: `PROJ-123` in the branch or commits, URLs pasted in the composer or in agent output, PRs opened from the space.
- Each link is fetched once through MCP (Jira, Linear, Sentry, GitHub servers) and summarised. Agents get the ticket, its acceptance criteria and the error trace without you pasting anything.
- `Ctrl K` then "staging", "ticket", "dashboard" opens it. `L` adds a link.
- Links of a repo (prod URL, runbook, dashboard) live in the repo config and show in every space that uses the repo.

### 2. Where was I
Today: back after two days, you reread the diff, scroll the terminal, ask the agent what it did.

Vela: opening a space you have not touched for a while shows a resume card: the goal, the decisions taken, what changed since you left (your edits, agent work, CI, review comments), what is blocked, and the next step. Built from the space brief, git history and agent logs. Dismiss with `Esc`, or `Enter` to do the next step.

The space brief is a short living document per space (goal, decisions, open questions). Agents append decisions to it; you approve them. It is sent to every agent as context and can be promoted into `AGENTS.md`.

### 3. Commit composer
Today: you stage by hand, invent a message, forget the ticket, mix a refactor with a feature.

Vela, on `C`:
- **Conventional commits by default.** Type and scope are inferred from the diff (`feat(billing)`, `test(webhook)`); scope comes from the path, mapped to packages. Breaking changes are detected when a public API, a migration or a config schema changes, and `!` plus a `BREAKING CHANGE:` footer are proposed.
- **Split suggestions.** "This diff is three commits": hunks grouped into feat, test and chore, each with its own message. Accept the plan with `Enter` or move hunks between groups with `J` `K` and `1` to `9`.
- **Ticket footer** from the context card (`Refs: PROJ-123`), co-author trailers for agents.
- **Repo rules respected**: reads commitlint, `.gitmessage`, existing history style; validates before committing.
- **Multi repo**: same message everywhere, or one per repo, cross-referenced.

### 4. Parallel attempts
Today: you try Claude Code, are not convinced, start over with Codex.

Vela: `@` with `Shift Enter` sends the same task to two or three agents (different tools or models), each in its own worktree. The Review view shows the attempts side by side per file. Take the whole attempt, or pick hunks from each. Cost and time of each attempt are shown.

### 5. PR loop inside the space
Today: you open the PR in the browser, wait for CI, read review comments, go back to the editor, find the line.

Vela: `P` opens one PR per repo, cross-linked, description written from the space brief and the diff. Then CI status and review comments come back into the Review view as items next to the code they target. `F` on a comment asks the author agent for a fix, `Y` resolves. Failing CI logs are attached to the item.

## Tier 2: trust and safety with agents

### 6. Line provenance
Every line knows who wrote it: you, or which agent, from which prompt, in which attempt. Shown in the gutter on hover and in blame. Kept after commit through `git notes`, so reviewers can ask "was this generated, and from what instruction?".

### 7. Risk ranked review
Proposals are sorted by risk, not by file: money, auth, migrations, concurrency and public APIs first. Trivial hunks (formatting, imports, renames, generated files) are grouped into one item you accept with one key. Each hunk shows whether a test covers it.

### 8. Checkpoints and rewind
Every agent step is a snapshot in its worktree. A timeline per agent lets you rewind to any step, or fork a new attempt from there with a different instruction.

### 9. Agents never block you
Agent questions from every space land in one queue with a desktop notification. Focus mode holds them until you are ready. Budgets per space (time, money) stop runaway agents.

## Tier 3: the environment follows the task

### 10. One environment per space
Containers per worktree with isolated ports, a seeded database snapshot, env vars per space (secrets from `pass`, 1Password or the system keyring), runtimes from mise. The running app of this space is one key away (`O`), on its own port, and its URL is in the context card.

### 11. Errors become context
Logs of the space containers and dev servers are tailed. Click an error, or let Vela catch it, and the stack trace, the request and the code around it go to the Debugger agent in one action.

### 12. Space scoped everything
Search, symbol navigation, terminal history and recent files are scoped to the repos of the space. No more results from the wrong project.

## Model additions these need

- `Space.links: Vec<Link { kind, url, title, source, fetched_summary }>`
- `Space.brief: Brief { goal, decisions, open_questions }`
- `Proposal { hunk, reason, attempt, risk, covered_by_tests }`
- `Note { hunk, by, level, text, fix }`, `AgentQuestion { agent, text, options }`
- `CommitPlan { groups: Vec<CommitGroup { type, scope, breaking, message, hunks }> }`
- `Provenance { line_range, author, prompt_id, attempt }` stored in git notes

## Proposed order

1. Context card with links and auto detection (no agent needed).
2. Commit composer: conventional commits, ticket footer, split suggestions.
3. Where was I, with the space brief.
4. Agents in their worktrees (M2), then parallel attempts and provenance.
5. PR loop.
6. Environment per space.
