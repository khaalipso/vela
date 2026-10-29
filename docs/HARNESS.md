# Vela as a meta harness

Vela does not ship its own coding agent. It drives existing harnesses (Claude Code, Codex, opencode, Crush, Gemini CLI) as APIs and adds what sits above them: the plumbing (worktrees, review, checks, commits, links, stack) and the UI. The intelligence is the agents; the value of Vela is orchestrating them and the interface around them.

An interactive terminal agent stays possible as an escape hatch, but it is not the main path: a terminal hides edits, questions and cost from Vela.

## Drivers

One `AgentDriver` per harness, all producing the same normalized event stream.

| Harness | Primary transport | Fallback |
| --- | --- | --- |
| Claude Code | ACP adapter (`claude-code-acp`) | `claude -p --output-format stream-json`, `--resume <session>` |
| Codex | ACP adapter (`codex-acp`) | `codex exec --json`, `codex exec resume` |
| opencode | `opencode acp`, or `opencode serve` HTTP + SSE | `opencode run` |
| Gemini CLI | ACP (`--experimental-acp`) | none |
| Crush | `crush run` non interactive | none |
| Any API model | direct provider API, for Vela's own small tasks | none |

ACP (Agent Client Protocol) is the preferred transport: one protocol for sessions, prompts, tool calls, file edits, permission requests and plans. Vela is an ACP client; each harness keeps its own tools, prompts and auth.

Every run happens in the agent's own worktree (`VELA_HOME/worktrees/<space>/.agents/<agent>/<repo>`). Reviewers run read only.

### Normalized events

`session_started`, `message` (text chunk), `plan` (steps), `tool_call` / `tool_result`, `file_changed` (path), `question` (permission request or explicit question, with options), `usage` (tokens, cost, model), `done`, `failed`.

Mapping to the UI:
- `question` goes to the Up next island and the cross-space queue, with a desktop notification.
- `file_changed` refreshes the proposals (diff of agent worktree against the user worktree).
- `usage` feeds the cost and budget of the space.
- `plan` shows on the agent card.

## What is implemented

### ACP

`crates/vela-agents/src/acp.rs` is an ACP client. A harness goes through ACP when its ACP server is installed: `opencode acp` (built into opencode), `claude-code-acp`, `codex-acp`, `gemini --experimental-acp`. Otherwise, or with `[agents.transport] <harness> = "cli"`, the CLI transport below is used.

A run is `initialize`, `session/new` (or `session/load` to resume; the replayed history is skipped, and a session that cannot be loaded falls back to a new one), then the model, the effort and the mode set through the session's config options (`session/set_config_option`, categories `model`, `thought_level`, `mode`) or the older `session/set_model` / `session/set_mode`, then one `session/prompt`. Read only roles switch to a plan mode. Its response ends the run and the process is stopped. Vela offers no file system or terminal capability: the harness keeps its own tools.

Updates map to the normalized events: message chunks are joined into one `message` per turn, `plan` entries to `plan`, `tool_call` / `tool_call_update` to `tool_call` (once per call) and `file_changed` (completed edits, diff contents), `usage_update` and the prompt's `usage` to `usage`.

`session/request_permission` does not end the run: it becomes a `question` (options in the order allow once, reject once, allow always, ...) and the agent shows as waiting while its process stays alive. The answer goes straight to the process: a named option, else the first allow option for a yes and the first reject option otherwise.

### CLI

`crates/vela-agents` has one driver per harness; each run is one non interactive process in its own process group (cancel kills the group). The prompt goes on stdin for Claude Code and Codex, last on the command line for opencode.

| Harness | Start | Resume (answer a question) | Read only |
| --- | --- | --- | --- |
| Claude Code | `claude -p --output-format stream-json --verbose [--model M] [--effort E] --permission-mode acceptEdits` | adds `--resume <session>` (and `--allowed-tools <t,..>` after a yes to a permission) | `--permission-mode dontAsk` with read tools and read-only git and shell commands allowed, writes disallowed |
| Codex | `codex exec --json --skip-git-repo-check -C <dir> -s workspace-write [-m M] [-c model_reasoning_effort="E"] -` | `codex exec resume --json --skip-git-repo-check -c sandbox_mode="..." [-m M] <thread> -` | `-s read-only` |
| opencode | `opencode run --format json [-m provider/model] [--variant E] --dir <dir> --agent build <prompt>` | adds `--session <id>` | `--agent plan` |

None of them reads answers on stdin in this mode, so a question ends the run (the agent shows as waiting) and the answer is a resumed run of the same session. Claude Code's `AskUserQuestion` and its `permission_denials` become questions; Codex `exec` never asks (its sandbox just refuses) but approval events are mapped if a newer version sends them; opencode permission events likewise. Unknown event types and lines that do not parse are ignored.

opencode always gets `--agent`: a `default_agent` in the user's opencode config that does not exist in the worktree made every run fail with "default agent not found".

Roles that only read (reviewer, planner, product, security) run read only in the user's worktree and get no worktree of their own. The others get one from the last commit of the space branch.

## Tiers

Agents are given a tier, not a model. A tier maps to a model per harness in config.

| Tier | For | Example mapping (configurable) |
| --- | --- | --- |
| `high` | Planning, architecture, hard debugging, final review | the most capable model of the harness |
| `medium` | Implementation, ordinary review | the default model |
| `low` | Commit subjects, link and log summaries, resume card, trivial fixes, test triage | a flash or small model |

Default role to tier: Planner high, Reviewer high, Debugger high, Product high, Security high, Developer medium, Tester low. Vela's own internal tasks always use `low`.

Each tier also has a reasoning effort per harness (`[agents.effort.<harness>]`), passed as `--effort` (Claude Code: low, medium, high, xhigh, max), `-c model_reasoning_effort` (Codex: minimal, low, medium, high, xhigh), `--variant` or the `thought_level` option (opencode). Not set: the harness default. Both are edited in the app under "Agent tiers" (Ctrl T, or the link in the Agents view), which writes the global config.

## Roles

| Role | Writes | Does |
| --- | --- | --- |
| Developer | own worktree | the change asked for |
| Tester | own worktree | writes or runs tests |
| Debugger | own worktree | finds the cause and fixes it |
| Planner | no | a plan as a list of steps |
| Reviewer | no | reviews the uncommitted changes, reports notes |
| Product | no | goal, user stories, acceptance criteria, edge cases, open questions |
| Security | no | injection, auth, secrets, input handling, dependencies, data exposure; reports notes |

## Prompts

A request is sent as: the Vela prompt (`crates/vela-agents/prompts/vela.md`: answer in the language of the request, work silently and give one answer at the end, investigate before answering, cite `file:line`, follow the project's conventions, stay in scope, never commit), the brief of the role (`prompts/<role>.md`: how to work and what the answer must contain), the NOTE format for reviewer and security, a `## Context` section (space, branch, repos and where the agent runs), `## Request` and what you asked, then a one-line reminder of the language and of the single answer.

Read only roles used to run in Claude Code's plan mode, where Claude writes a plan to investigate instead of investigating ("Here is the plan to verify it"). They now run with `--permission-mode dontAsk`: reading, searching and read-only commands are allowed, writes are refused without a question. The briefs can be edited in the app (Agents view, "Prompts", or Ctrl T "Agent prompts"); they are stored in `[agents.prompts]` of the global config, and a repo can override them in `.vela/config.toml`. The NOTE format is still appended for the reviewer and security roles.

The Agents view takes a follow up on a finished agent (a resumed run of its session, in its own worktree) and reruns a request after editing it (the composer opens with its role, harness, tier and text). The harness picked in the composer stays picked for the next requests and across restarts.

Harness detection (`--version` of each, in parallel) is cached for five minutes and warmed at startup; starting an agent only looks the binaries up on the `PATH`. opencode's model list (`opencode models`) is fetched in the background and cached for ten minutes.

## Reviewer notes

The reviewer and security agents are asked to end their answer with one line per finding: `NOTE <blocking|warning|info> <path>:<line> <text>`. Those lines become notes, tied to the hunk whose lines contain them (`vela_agents::notes`). The Review view shows them on their hunk, or at the top of the file when no hunk holds them. `F` sends a note for a fix: the agent that proposed the hunk gets it as a resumed run of its session when it can be resumed, else a new developer agent starts with the note as its request; the note is resolved when that agent is done. `Shift Y` resolves a note by hand. What the user did with the notes is kept in `VELA_HOME/spaces/<space>.notes.json`. `vela notes <space>` lists them.

```toml
# ~/.config/vela/config.toml
[agents.tiers.claude]
high = "opus"
medium = "sonnet"
low = "haiku"

[agents.tiers.codex]
high = "<model>"
medium = "<model>"
low = "<model>"

[agents.effort.claude]
high = "max"
medium = "high"

[agents.roles]
planner = { tier = "high", harness = "claude" }
developer = { tier = "medium", harness = "codex" }
tester = { tier = "low", harness = "opencode" }

[agents.transport]
codex = "cli"     # acp (default when the ACP server is installed) or cli
```

A space can override roles, and a single request can be bumped (`@` then `Ctrl ↑` raises the tier).

## Later ideas

- **Decision model.** A small model that, for each request, picks the harness, tier and number of parallel attempts (and whether a plan step is needed first), learning from which proposals you accepted. Keep for later, after enough usage data.
