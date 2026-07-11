# Visible Subagent Graceful Return Design

## Goal

Add a keyboard shortcut inside a visible subagent pane that asks the running agent to stop acquiring new information, summarize the work already completed, return that summary to the parent agent, and close cleanly.

The feature supplements, rather than changes, the existing hard-interrupt behavior:

- `Ctrl+Shift+S`: cooperative stop, summarize, return, and close.
- `Escape`: immediately abort the current turn and leave the pane open.

## Current Behavior

The child extension in `extensions/subagents/tools/visible-auto-exit.ts` registers `Ctrl+Shift+J` to expand or collapse its tool widget. It also handles normal auto-exit, `caller_ping`, and `subagent_done`.

The parent watches each visible run's exit file. After the child exits, it obtains output from the child session when available, otherwise from pane capture, and sends a `subagent_visible_result` message that triggers a parent turn.

`subagent_interrupt` sends `Escape` to the child pane. Pi records the interrupted assistant turn with `stopReason: "aborted"`; the child deliberately does not auto-exit. Consequently, hard interruption does not give the child another turn in which to summarize and does not immediately return a completion result to the parent.

## User Interaction

The collapsed child widget will advertise both controls:

```text
[researcher] — 4 tools  (Ctrl+Shift+J expand · Ctrl+Shift+S summarize & return · Esc abort)
```

The expanded widget will use the same shortcut wording with `collapse` in place of `expand`.

After `Ctrl+Shift+S` is pressed, the widget will show that return has been requested. Pressing it again will not enqueue another message.

`Ctrl+Shift+S` follows the same terminal compatibility assumption as the existing `Ctrl+Shift+J`: terminals that cannot distinguish modified control keys may not deliver it. `Escape` remains the universal fallback.

## Control Flow

The child extension will maintain a `gracefulReturnRequested` boolean.

On the first `Ctrl+Shift+S` press it will:

1. Set `gracefulReturnRequested` before sending any message, preventing duplicate requests.
2. Re-render the widget to show `return requested`.
3. Call `pi.sendUserMessage()` with `deliverAs: "steer"`.

The injected instruction will tell the child to:

- stop starting new searches and tool calls;
- use only information already obtained;
- provide a concise final report containing completed work, main findings, and incomplete or uncertain items;
- treat that report as its final response.

Pi's steering queue allows an in-flight tool call to finish, then presents the instruction before the next model call. This is intentionally cooperative: it avoids discarding a useful tool result. A hung or excessively slow tool can still be aborted with `Escape`.

When the summary turn ends without `stopReason: "aborted"`, the existing `agent_end` lifecycle will write the exit marker and shut down the child. For interactive children, `gracefulReturnRequested` will explicitly enable this one-time shutdown even though their normal `autoExit` setting is false.

The existing parent watcher remains the result transport. It reads the final assistant output through the current session-summary/pane-capture path and sends `subagent_visible_result` to the parent with `triggerTurn: true`.

## State and Failure Handling

| State | Shortcut behavior |
|---|---|
| Agent running or executing a tool | Queue one steering request; summarize after the current tool returns |
| Agent idle | Start the summary turn immediately |
| Return already requested | Do not enqueue another request; retain status in widget |
| Summary turn succeeds | Write normal exit marker, close pane, deliver result to parent |
| Summary turn is aborted with `Escape` | Do not claim graceful completion; keep the pane open under existing abort behavior |
| Tool hangs | User may use `Escape`; no automatic timeout is added |
| Model/tool error | Preserve the existing watcher and pane-capture fallback behavior |

No new temporary-file protocol, parent-side polling mode, timeout, or forced process termination will be introduced.

## Files in Scope

- `extensions/subagents/tools/visible-auto-exit.ts`
  - register the new shortcut;
  - inject the steering instruction;
  - track graceful-return state;
  - update widget text;
  - close interactive children after the requested summary.
- `extensions/subagents/tools/visible-auto-exit-helpers.ts`
  - only if a small pure lifecycle predicate is needed for testability.
- `extensions/subagents/test/visible-auto-exit.test.ts`
  - cover lifecycle decisions for requested return, normal completion, and aborted summary.
- A focused test for shortcut/request deduplication if the logic is extracted into a pure helper.
- `extensions/subagents/README.md`
  - correct the stale `Ctrl+J` documentation to `Ctrl+Shift+J` and document `Ctrl+Shift+S`.

No changes are required to `subagent_interrupt`, the visible-pane backend, or the parent result message format.

## Verification

Automated checks will verify:

1. A normal autonomous child still exits after a non-aborted final turn.
2. A normal interactive child still remains open without a graceful-return request.
3. An interactive child exits after a requested summary completes.
4. An aborted summary does not report graceful completion or close automatically.
5. Repeated shortcut presses produce only one steering request.
6. Existing visible-subagent tests continue to pass.

A manual visible-pane smoke test will verify:

1. Start a visible `researcher` task that performs more than one search.
2. Press `Ctrl+Shift+S` while it is working.
3. Confirm the widget changes to `return requested`.
4. Confirm the child stops starting new work, reports findings and incomplete items, then closes.
5. Confirm the parent receives that report and starts a follow-up turn.
6. Separately press `Escape` during another run and confirm the existing hard-abort/keep-pane behavior remains unchanged.

## Non-goals

- Changing `Escape` into a graceful stop.
- Automatically killing hung tools after a timeout.
- Streaming the child transcript continuously to the parent.
- Adding a parent-pane shortcut that targets one of several children.
- Changing synchronous `subagent` behavior; this feature applies only to visible subagent panes.
