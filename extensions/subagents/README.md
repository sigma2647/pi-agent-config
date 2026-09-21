# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in multiplexer panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all running agents with their current state — `starting`, `active`, `waiting`, `stalled`, or `running`. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)        active · bash 7m │
│ 00:45  Scout: DB (scout)                waiting 2m │
╰────────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Install

```bash
pi install git:github.com/HazAT/pi-interactive-subagents
```

Supported multiplexers:

- [cmux](https://github.com/manaflow-ai/cmux)
- Herdr
- [tmux](https://github.com/tmux/tmux)
- [zellij](https://zellij.dev)
- [WezTerm](https://wezfurlong.org/wezterm/) (terminal emulator with built-in multiplexing)

Start pi inside one of them:

```bash
cmux pi
# or
# run pi from a Herdr pane
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm — no wrapper needed
```

Optional: set `PI_SUBAGENT_MUX=cmux|herdr|tmux|zellij|wezterm` to force a specific backend.

If your shell startup is slow and subagent commands sometimes get dropped before the prompt is ready, set `PI_SUBAGENT_SHELL_READY_DELAY_MS` to a higher value (defaults to `500`):

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

Subagent panes are created without stealing keyboard focus (cmux, tmux). Launch commands target child surfaces by explicit ID, so focus and command delivery are independent. Note: the `interactive` option controls parent status notifications, not terminal focus.

## What's Included

### Extensions

**Subagents** — 5 main-session tools + 3 commands, plus 2 subagent-only tools:

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `subagent`           | Spawn a sub-agent in a dedicated multiplexer pane (async — returns immediately)             |
| `subagent_interrupt` | Interrupt a running Pi-backed subagent's current turn                                       |
| `subagents_list`     | List available agent definitions                                                            |
| `subagent_resume`    | Resume a previous sub-agent session by path (async)                                         |
| `subagent_message`   | Message a sub-agent by name: answers a waiting child, steers a running one, resumes a finished one |

Subagent-only tools: `ask_question` (ask the parent and park) and `subagent_done` (interactive agents only).

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/subagent [<agent> [task]]` | Choose or spawn a named agent directly |

`/subagent` with no arguments opens a visual agent picker and then prompts for the task. While typing `/subagent <agent>`, the editor shows matching agent names and descriptions; press `Tab` to force the candidate list, use `↑`/`↓` to move, and confirm with `Tab` or `Enter`. Agents with `disable-model-invocation: true` are omitted from both discovery surfaces.

### Bundled Agents

| Agent             | Model                  | Role                                                                                     |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| **planner**       | DeepSeek V4 Pro (medium thinking) | Brainstorming — clarifies requirements, explores approaches, writes plans with implementation tasks |
| **scout**         | DeepSeek V4 Flash      | Fast codebase reconnaissance — maps files, patterns, conventions                         |
| **researcher**    | DeepSeek V4 Flash      | Searches the web and synthesizes focused, sourced findings                               |
| **worker**        | DeepSeek V4 Flash (minimal thinking) | Implements well-scoped tasks — writes code, runs tests, and reports verified results     |
| **reviewer**      | DeepSeek V4 Pro (medium thinking) | Reviews code for bugs, security issues, correctness                                      |
| **visual-tester** | DeepSeek V4 Flash      | Visual QA via browser-probe — screenshots, interaction testing, console/network checks      |

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location.

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in mux pane      → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks all running agents:

```
╭─ Subagents ───────────────────────────────── 3 running ─╮
│ 01:23  Scout: Auth (scout)            active · write 7m │
│ 00:45  Researcher (researcher)               stalled 4m │
│ 00:12  Scout: DB (scout)                      starting… │
╰─────────────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path.

### In-progress status updates

The widget tracks each Pi-backed sub-agent from a child-written runtime snapshot and labels it with a coarse state:

- `starting` — launched, but no valid child snapshot has been observed yet
- `active` — the child is doing observed runtime work: agent turn, provider request, streaming, or tool execution
- `waiting` — the child finished a turn and is intentionally open for more input or another stage
- `stalled` — the parent has gone too long without a valid current child snapshot and can no longer trust the run is healthy
- `running` — fallback for backends without child snapshots (e.g. Claude)

These labels are no longer derived from session-file growth. Session JSONL is still used for transcript, resume, lineage, and result extraction, but Pi-backed liveness now comes from a small activity snapshot written by the child extension. A fixed internal watchdog marks a run as `stalled` when valid snapshots never appear, stop being readable, or stop matching the current child; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. When a run enters `stalled` or recovers from it, the parent agent receives a steer message so it can react. All other status transitions stay in the widget only.

**Interactive subagents stay silent.** Long-running user-driven subagents (e.g. `planner`, or any `/iterate` fork) do not wake the parent session on `stalled`/`recovered` transitions — the user is working directly in the subagent's pane, and a steer message there would just burn an orchestrator turn on a no-op "still waiting" ping. The widget still updates normally, and child snapshots are still recorded/classified regardless of the `interactive` setting. By default, agents with `auto-exit: true` are treated as autonomous and get stall pings; agents without it are treated as interactive and stay quiet. Override per-agent with `interactive: true|false` in frontmatter, or per-spawn with `interactive: true|false` on the tool call.

#### Configuration

Status display is controlled by `config.json` in the extension directory. Copy `config.json.example` to get started:

```bash
cp config.json.example config.json
```

```json
{
  "status": {
    "enabled": true
  }
}
```

`config.json` is gitignored so local overrides don't get committed.

---

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Agent defaults can choose a different session-mode via frontmatter
subagent({ name: "Planner", agent: "planner", task: "Work through the design with me" });

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter              | Type    | Default        | Description                                                                                       |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | string  | required       | Display name (shown in widget and pane title)                                                     |
| `task`                 | string  | required       | Task prompt for the sub-agent                                                                     |
| `agent`                | string  | —              | Load defaults from agent definition                                                               |
| `fork`                 | boolean | `false`        | Force the full-context fork mode for this spawn, overriding any agent `session-mode` frontmatter  |
| `interactive`          | boolean | derived        | Mark this spawn as interactive (don't wake the parent on stall/recovery). Defaults to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`. |
| `model`                | string  | session model  | Override the model. Resolution: param → agent `model` frontmatter → parent session's current model. Must be an exact `provider/model` reference available in this session (see `subagents_list`); unavailable references are rejected at spawn time. |
| `systemPrompt`         | string  | —              | Append to system prompt                                                                           |
| `skills`               | string  | —              | Comma-separated skill names                                                                       |
| `tools`                | string  | —              | Comma-separated tool names                                                                        |
| `cwd`                  | string  | —              | Working directory for the sub-agent (see [Role Folders](#role-folders))                           |

---

## Interrupting a running subagent

Use `subagent_interrupt` to cancel the active turn of a running Pi-backed subagent:

```typescript
subagent_interrupt({ id: "abcd1234" });
// or
subagent_interrupt({ name: "Scout" });
```

This sends Escape to the child pane, cancelling the in-progress model turn. The subagent session stays alive — the pane, session file, and background polling all remain intact. After the interrupt, the widget immediately moves the child back to `waiting`, and stale pre-interrupt snapshots are ignored. If the child starts work later, newer snapshots return it to `active`; completion, failure, and `ask_question` still flow through normally.

This is a turn-level interrupt, not a method for forcibly terminating a subagent session.

> **Note:** Only Pi-backed subagents are supported. Claude-backed runs will return an error.

---

## ask_question / subagent_message — Child-to-Parent Conversation

The `ask_question` tool lets a subagent ask its parent a question **without dying**. The
child parks: its pane stays open, its session stays alive, and the parent's answer arrives
as the child's next user message. `caller_ping` is kept as an alias for older agent
prompts, and now behaves the same way (it used to exit the session).

**`ask_question` parameters:**
- `question` (required): the question, with the context the parent needs to answer

**`subagent_message` parameters:**
- `name` (required): the sub-agent's display name
- `message` (required): the answer or follow-up instruction

**Interaction flow:**
1. Child calls `ask_question({ question: "v1 or v2 for the migration?" })` and ends its turn
2. Parent receives a steer notification naming the child and the question
3. Parent answers with `subagent_message({ name: "Worker", message: "Use v2, v1 is deprecated" })`
4. The answer is typed into the child's live pane; the child continues from where it stopped

**Example:**
```typescript
// Inside a worker subagent
await ask_question({
  question: "Found two conflicting migration files — should I use v1 or v2?"
});
// End your turn here. The answer arrives as your next user message.
```

### `subagent_message` does three things

| Target state | What happens |
| --- | --- |
| Waiting on `ask_question` | The message is typed into its pane and unblocks it; its question queue is cleared |
| Still running | Same channel — it redirects the child at its next turn boundary |
| Already finished | Its session is resumed in a new pane with your message as the follow-up task |
| Unknown to this process (parent restarted) | The durable registry resolves the name, then resumes |

Messages are flattened to one line before being typed, so a multi-line answer does not get
submitted as several prompts. Delivery is asynchronous: the child's result still comes back
as a steer message, so do not assume the message has been read yet.

### Resuming with an explicit session path

`subagent_resume` still exists for the case where the name is unknown (a different session,
or after a restart):

- `sessionPath` (required): Path to the child session `.jsonl` file
- `name` (optional): Display name for the resumed pane (defaults to `Resume`)
- `message` (optional): Follow-up prompt to send after resuming
- `autoExit` (optional): Whether the resumed session should auto-exit after its next response. Defaults to `true` for autonomous follow-up work; set `false` when resuming for an interactive handoff.

### What is durable about a question

- The question is written to `<session>.asks.json` next to the child's session file and is
  **only cleared when the answer is sent**. It is not deleted on read, so a parent restart
  does not lose it and two questions asked in the same turn both reach the parent.
- Each question carries a short id which the notification shows. That is what lets the
  parent find the question again after its context is compacted.
- A name survives a parent restart: `<artifact-dir>/subagent-registry.json` records every
  child's name, session file, pane and state. When the in-memory tables miss, `subagent_message`
  falls back to that file and resumes the conversation by name.
- A **parked** child keeps its pane when the parent shuts down. It is waiting for an answer,
  not cancelled work, so the pane is deliberately left open. If a resume happens after a
  restart, the tool says which pane from the earlier session may still be open.

### Edge cases

- If the parent never replies, the child pane stays open. Nothing is lost; answer it later.
- A child that asks and then keeps working clears its waiting state on the next tool call, so
  it still auto-exits normally when it finishes.
- Two children with the same name are refused rather than guessed at — the tool lists their
  ids instead of messaging one of them.
- Both tools are only available inside subagent contexts, and neither is reachable through
  `spawning: false` (messaging can resume a child, which creates a pane).
- Claude-backed sub-agents cannot be messaged: typing into their pane is not supported, and
  their transcript is not a pi session.

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm plan and implementation tasks, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement plan tasks
Phase 5: Review           → Reviewer subagent checks all changes
```

Tab/window titles update to show current phase:

```
🔍 Investigating: dark mode → 💬 Planning: dark mode
→ 🔨 Executing: 1/3 → 🔎 Reviewing → ✅ Done
```

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context. It does not inherit an agent default `session-mode`. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global):

```markdown
---
name: my-agent
description: Does something specific
thinking: minimal
tools: read, bash, edit, write
session-mode: lineage-only
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Model resolution

Nothing is hardcoded to a provider. The child's model resolves in this order:

1. Explicit `model` tool param
2. Agent frontmatter `model` (optional pin, validated against the session's available models — a stale value fails fast instead of crashing the child)
3. **The subagent model pool** (if configured) — a prioritized list; the first entry that is available in this session and not in cooldown wins
4. **The parent session's current model** — the default when no pool is configured. Subagents follow whatever model the main session runs, so switching providers requires no agent-file edits.
5. If none resolve, no `--model` is passed and the child uses its own default from settings.

#### Model pool (priority order + automatic fallback)

When a subagent dies from a **provider error** (429 rate limit, overload — the child's own auto-retry already exhausted), the run is **automatically relaunched on the next pool entry** instead of surfacing the failure. Each entry is tried at most once per spawn; models that failed go into a **cooldown** (default 10 min) so parallel spawns skip them too. The result message shows the fallback trail (e.g. `Model fallback: glm-5.3 → glm-5.2 …`).

Configure the pool in `<agent config dir>/subagent-models.json`, or override with the env var `PI_SUBAGENT_MODEL_POOL` (comma- or newline-separated). Cooldown length: `PI_SUBAGENT_MODEL_COOLDOWN_MS` (or the JSON `cooldownMs`, default `600000`).

```json
// ~/.pi/agent/subagent-models.json
{
  "models": [
    "zai-coding-cn/glm-5.3",
    { "ref": "zai-coding-cn/glm-5.2", "note": "same account, cheaper" },
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash"
  ],
  "cooldownMs": 600000
}
```

Each `models` entry is either a `provider/model[:thinking]` string or an object `{"ref": "...", "note": "..."}`. The `note` is free text shown next to the entry by `subagents_list`. Array order is the priority order.

A malformed JSON file throws a fix-it message at spawn time instead of silently disabling the pool — a typo must not look like "no pool configured".

The legacy `subagent-models.txt` (one ref per line, `#` comments) still works, but only when no JSON file exists:

```
# ~/.pi/agent/subagent-models.txt
zai-coding-cn/glm-5.3
zai-coding-cn/glm-5.2
```

Call `subagents_list` to see the active pool (including which entries are in cooldown). Claude CLI children (`cli: claude`) ignore the pool — `claude --model` has different semantics.

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                                                                                                                                    |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Optional model pin (`provider/model`). Validated against the session's available models at spawn time. Omit to inherit the parent session's current model — recommended when you switch providers often.                                                                                                                                    |
| `thinking`    | string  | Thinking level: `minimal`, `medium`, `high`                                                                                                                                                                                                                                 |
| `tools`       | string  | Comma-separated tool names: pi built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) plus extension tools such as `web_search`, `web_fetch`, `browser_probe` |
| `skills`      | string  | Comma-separated skill names to auto-load                                                                                                                                                                                                                                    |
| `session-mode` | string | Default child-session mode: `standalone`, `lineage-only`, or `fork` |
| `spawning`    | boolean | Set `false` to deny all subagent-spawning tools                                                                                                                                                                                                                             |
| `deny-tools`  | string  | Comma-separated extension tool names to deny                                                                                                                                                                                                                                |
| `output`      | string  | Declares a report file (e.g. `context.md`). At spawn the child is handed `<session-artifact-dir>/reports/<agent>-<timestamp>-<output>` and told to write the long version there and keep its final message to that path plus ~10 lines. The declared value is a file-name suffix — any directory part is ignored, so a child can never write into the caller's working tree by accident. Omit for agents that return their result directly (e.g. `worker`). |
| `auto-exit`   | boolean | Auto-shutdown when the agent finishes its turn — no `subagent_done` call needed. If the user sends any input, auto-exit is permanently disabled and the user takes over the session. Recommended for autonomous agents (scout, worker); not for interactive ones (planner). Also determines the default value of `interactive` (see below). |
| `interactive` | boolean | derived        | Override whether stall/recovery transitions wake the parent session. Defaults to the inverse of `auto-exit`: autonomous agents (`auto-exit: true`) are non-interactive and get stall pings; agents without `auto-exit` are interactive and stay quiet. Explicit values take precedence. |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide this agent from discovery surfaces like `subagents_list`. The agent still remains directly invokable by explicit name via `subagent({ agent: "name", ... })`. |

---

Discovery still resolves precedence before visibility filtering. If a project-local hidden agent has the same name as a visible global or bundled agent, the hidden project agent wins and the lower-precedence agent does not appear in `subagents_list`.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call always forces the `fork` mode for that specific spawn. `/iterate` uses this explicit override on purpose.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### `auto-exit`

When set to `true`, the agent session shuts down automatically as soon as the agent finishes its turn — no explicit `subagent_done` call is needed.

**Behavior:**

- The session closes after the agent's final message (on the `agent_end` event)
- If the user sends **any input** before the agent finishes, auto-exit is permanently disabled for that session — the user takes over interactively
- The modeHint injected into the agent's task is adjusted accordingly: autonomous agents see "Complete your task autonomously." rather than instructions to call `subagent_done`

**When to use:**

- ✅ Autonomous agents (scout, worker, reviewer) that run to completion
- ❌ Interactive agents (planner, iterate) where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

### `interactive`

Controls whether status transitions (`stalled`, `recovered`) wake the parent session with a steer message.

**Default:** the inverse of `auto-exit`. Autonomous agents (`auto-exit: true`) are non-interactive and ping the parent on stall/recovery; agents without `auto-exit` are interactive and stay quiet. Bare spawns with no agent defs (e.g. `/iterate` with `fork: true`) are treated as interactive.

**Why it exists:** Interactive agents can run for minutes or hours while the user thinks, types, and reads in the subagent's pane. Child snapshots still update the widget, but stalled/recovered supervision messages rarely need to wake the parent for user-driven sessions. Skipping the steer keeps the parent quiet until the child actually finishes.

**When to override:**

- Set `interactive: false` on an agent that doesn't auto-exit but you still want stall pings for
- Set `interactive: true` on an autonomous agent you'd rather check on yourself

```yaml
---
name: planner
# interactive defaults to true because auto-exit is not set
---
```

Or per spawn:

```typescript
subagent({ name: "Scout", agent: "scout", interactive: true, task: "..." });
```

---

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

### The depth cap (the backstop)

Frontmatter is per-agent and can be wrong; a chain cannot. Each spawn counts one
level, the number travels in the environment from parent to child, and a session at
the limit does not receive the spawning tools at all:

```
top-level session (depth 0) → planner (depth 1) → scout (depth 2, cannot spawn)`
```

The limit is **2** (the top-level session plus two levels below it). Change it per chain
by exporting `PI_SUBAGENT_MAX_DEPTH` in the top-level session: `0` forbids every spawn,
`1` allows children but no grandchildren.

The cap also applies when a finished child is **resumed**: a resume is a new pi process,
so the level and the deny list are re-applied to it. Without that, a resumed `scout`
would come back with the spawn tools it was denied.

Known gap: a sub-agent that starts another pi *through bash* inherits the current level
but does not add one, so it can spawn a sibling-level child. Only the documented spawn
tool increments the count.

### `spawning: false`

Denies all subagent lifecycle tools (`subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume`, `subagent_message`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: subagent
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | _(default)_ | Legitimately spawns scouts for investigation. Capped at 2 spawns, `scout`/`researcher` only |
| worker     | `false`     | Should implement tasks, not delegate         |
| researcher | `false`     | Should research, not spawn                   |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

`scout` and `researcher` are the only agents the planner may spawn; the planner is
therefore the only place a spawn tree can start, and it ends one level down.

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, ...
  denied: subagent, subagents_list, ...
```

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- One supported multiplexer:
  - [cmux](https://github.com/manaflow-ai/cmux)
  - Herdr
  - [tmux](https://github.com/tmux/tmux)
  - [zellij](https://zellij.dev)
  - [WezTerm](https://wezfurlong.org/wezterm/)

```bash
cmux pi
# or
# run pi from a Herdr pane
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm
```

Optional backend override:

```bash
export PI_SUBAGENT_MUX=cmux   # or herdr, tmux, zellij, wezterm
```

---

## Acknowledgements

The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---

## License

MIT
