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

## What is implemented (M2)

Only the fallback transports exist for now (no ACP). `crates/vela-agents` has one driver per harness; each run is one non interactive process in its own process group (cancel kills the group). The prompt goes on stdin for Claude Code and Codex, last on the command line for opencode.

| Harness | Start | Resume (answer a question) | Read only |
| --- | --- | --- | --- |
| Claude Code | `claude -p --output-format stream-json --verbose [--model M] --permission-mode acceptEdits` | adds `--resume <session>` (and `--allowed-tools <t,..>` after a yes to a permission) | `--permission-mode plan` |
| Codex | `codex exec --json --skip-git-repo-check -C <dir> -s workspace-write [-m M] -` | `codex exec resume --json --skip-git-repo-check -c sandbox_mode="..." [-m M] <thread> -` | `-s read-only` |
| opencode | `opencode run --format json [-m provider/model] --dir <dir> <prompt>` | adds `--session <id>` | `--agent plan` |

None of them reads answers on stdin in this mode, so a question ends the run (the agent shows as waiting) and the answer is a resumed run of the same session. Claude Code's `AskUserQuestion` and its `permission_denials` become questions; Codex `exec` never asks (its sandbox just refuses) but approval events are mapped if a newer version sends them; opencode permission events likewise. Unknown event types and lines that do not parse are ignored.

Roles that only read (reviewer, planner) run read only in the user's worktree and get no worktree of their own. The others get one from the last commit of the space branch.

## Tiers

Agents are given a tier, not a model. A tier maps to a model per harness in config.

| Tier | For | Example mapping (configurable) |
| --- | --- | --- |
| `high` | Planning, architecture, hard debugging, final review | the most capable model of the harness |
| `medium` | Implementation, ordinary review | the default model |
| `low` | Commit subjects, link and log summaries, resume card, trivial fixes, test triage | a flash or small model |

Default role to tier: Planner high, Reviewer high, Debugger high, Developer medium, Tester low. Vela's own internal tasks always use `low`.

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

[agents.roles]
planner = { tier = "high", harness = "claude" }
developer = { tier = "medium", harness = "codex" }
tester = { tier = "low", harness = "opencode" }
```

A space can override roles, and a single request can be bumped (`@` then `Ctrl ↑` raises the tier).

## Later ideas

- **Decision model.** A small model that, for each request, picks the harness, tier and number of parallel attempts (and whether a plan step is needed first), learning from which proposals you accepted. Keep for later, after enough usage data.
