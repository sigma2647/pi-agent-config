# Herdr Subagent Mux Support Design

## Goal

Allow the vendored `subagents` extension to launch and manage asynchronous subagents from a Herdr pane.

## Scope

Add Herdr to the existing mux adapter at `extensions/subagents/pi-extension/subagents/cmux.ts`. The supported lifecycle is: detect the current parent pane, create a non-focused right split, execute commands in the child pane, send Escape, read output, and close the pane.

## Design

`MuxBackend` gains a `herdr` variant. Runtime availability requires both the `herdr` executable and successful parsing of `herdr pane current`; merely having the executable on `PATH` is insufficient. The command runs inside Pi's own pane, which need not be the terminal's focused pane.

The adapter uses the established Herdr commands from the previous implementation:

- `herdr pane current`
- `herdr pane split --pane <id> --direction right --cwd <cwd> --no-focus`
- `herdr pane rename <id> <name>`
- `herdr pane run <id> <command>`
- `herdr pane send-keys <id> Escape`
- `herdr pane read <id> --source recent-unwrapped --lines <n> --format text`
- `herdr pane close <id>`

Herdr has no verified workspace/tab-renaming equivalent in the prior implementation. `renameCurrentTab` and `renameWorkspace` therefore intentionally do nothing for Herdr rather than accidentally invoking the Zellij fallback.

## Testing

Add unit tests for parsing the Herdr JSON responses and text fallback for split output. Run the full existing unit suite; live Herdr integration remains conditional on a real Herdr session, like the other mux backends.

## Constraints

- No new dependency.
- Do not alter existing cmux, tmux, Zellij, or WezTerm behavior.
- Respect `PI_SUBAGENT_MUX=herdr`.
- Update README and runtime setup hints to list Herdr.
