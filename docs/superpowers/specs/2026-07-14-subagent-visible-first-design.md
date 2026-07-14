# Subagent Visible-First Design

**Date:** 2026-07-14

## Goal

Make `subagent` prefer the existing visible Herdr/tmux execution path while preserving synchronous execution as a fallback when no supported live mux target exists. Fix Herdr detection so a valid parent pane is not rejected merely because it is not currently focused.

## Current Problem

`detectVisibleTarget()` calls `herdr pane current` and only accepts the returned pane when `focused === true`. A Pi process can still be running inside a valid Herdr pane after the user focuses another pane. In that state Herdr injects `HERDR_ENV=1` and `HERDR_PANE_ID`, but detection returns `null` and `subagent_visible` reports that no live mux exists.

## Behavior

### `subagent`

1. Resolve and validate the requested agent exactly as today.
2. Detect a supported visible target.
3. If a target exists, launch through the existing asynchronous visible-subagent lifecycle and return immediately.
4. If no target exists, run through the existing synchronous headless lifecycle.
5. If a target was detected but pane creation or launch fails, return the launch error; do not silently retry synchronously.

The result shape and renderer may differ by selected lifecycle: visible launches return the existing started/pane acknowledgement, while synchronous fallback returns the completed agent result.

### `subagent_visible`

Keep this as the explicit strict-visible tool. It never falls back to synchronous execution and retains its current error when no supported live mux exists.

### Herdr target detection

Use the parent process identity rather than UI focus:

1. When `HERDR_ENV=1`, `HERDR_PANE_ID` is non-empty, and the `herdr` command is available, use `HERDR_PANE_ID` as the split anchor.
2. Otherwise retain the existing `herdr pane current` fallback and its focus check, preventing an unrelated globally focused pane from being selected outside an identified Herdr process.
3. Keep existing tmux detection and explicit backend preference behavior.

This follows Herdr's documented pane environment contract and the local `pi-interactive-subagents` pattern of targeting the parent mux pane by inherited ID rather than current UI focus.

## Prompt and Command Surfaces

Update `subagent` descriptions and guidance to state that it is visible-first and falls back synchronously only when no live mux is available. Keep `subagent_visible` descriptions explicit about strict visible execution. Apply the same visible-first behavior to the `/subagent` command so tool and command semantics remain aligned.

## Tests

Add focused regressions that prove:

- Herdr detection accepts `HERDR_PANE_ID` even when `herdr pane current` would report `focused: false`.
- Herdr detection does not treat an environment pane ID as valid without the Herdr runtime marker/command.
- `subagent` selects visible execution when target detection succeeds.
- `subagent` selects synchronous execution only when target detection returns no target.
- A visible launch failure is surfaced and does not trigger synchronous fallback.
- Existing strict `subagent_visible` behavior and the full subagents test suite remain green.

## Non-goals

- No new mux backends.
- No retry, smart routing, or fallback after a detected mux launch failure.
- No new user-facing mode flag.
- No removal or aliasing of `subagent_visible`.
- No changes to visible pane lifecycle, auto-exit, resume, interrupt, or completion delivery.
