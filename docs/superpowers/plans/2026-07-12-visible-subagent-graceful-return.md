# Visible Subagent Graceful Return Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Ctrl+Shift+S` to visible subagent panes so a running child cooperatively stops new work, summarizes existing findings, returns the report to its parent, and closes.

**Architecture:** The child-only `visible-auto-exit.ts` extension will register a second shortcut and inject a Pi steering user message. A closure boolean will deduplicate requests, update the widget, and let interactive children use the existing clean-exit path after the summary; the existing parent watcher remains unchanged.

**Tech Stack:** TypeScript, Pi extension API (`registerShortcut`, `sendUserMessage`, lifecycle events), Node's built-in test runner.

## Global Constraints

- `Ctrl+Shift+S` is cooperative; `Escape` remains the hard-abort control.
- Do not add a temporary-file protocol, timeout, forced termination, or parent-side shortcut.
- Do not change `subagent_interrupt`, visible-pane backends, or parent result message format.
- Repeated `Ctrl+Shift+S` presses must enqueue exactly one steering message.
- A requested summary closes both autonomous and interactive children only after a non-aborted assistant turn.
- Every relative TypeScript import must end in `.ts`.

---

## File Structure

- Modify `extensions/subagents/tools/visible-auto-exit.ts`: own the shortcut, steering prompt, request state, widget copy, and child lifecycle behavior.
- Modify `extensions/subagents/tools/visible-auto-exit-helpers.ts`: include graceful-return state in the pure exit predicate.
- Modify `extensions/subagents/test/visible-auto-exit.test.ts`: verify exit decisions, shortcut delivery, and request deduplication with a fake extension API.
- Modify `extensions/subagents/README.md`: document both visible-pane shortcuts and distinguish graceful return from hard abort.

No new production file or dependency is needed.

### Task 1: Graceful-return lifecycle and shortcut

**Files:**
- Modify: `extensions/subagents/test/visible-auto-exit.test.ts`
- Modify: `extensions/subagents/tools/visible-auto-exit-helpers.ts:5-13`
- Modify: `extensions/subagents/tools/visible-auto-exit.ts:11-93`

**Interfaces:**
- Consumes: Pi's existing `sendUserMessage(content, { deliverAs: "steer" })` and `agent_end` event.
- Produces: `shouldAutoExitOnAgentEnd(autoExit, userTookOver, gracefulReturnRequested, messages): boolean`; internal `GRACEFUL_RETURN_PROMPT: string`; registered shortcut `ctrl+shift+s`; closure state `gracefulReturnRequested: boolean`.

- [ ] **Step 1: Add failing lifecycle assertions for interactive graceful return**

Replace the existing auto-exit test block in `extensions/subagents/test/visible-auto-exit.test.ts` with calls to the new four-argument predicate:

```ts
it("closes autonomous work and requested graceful returns after a non-aborted assistant turn", () => {
	assert.equal(shouldAutoExitOnAgentEnd(true, false, false, [{ role: "assistant", stopReason: "stop" }]), true);
	assert.equal(shouldAutoExitOnAgentEnd(true, true, false, [{ role: "assistant", stopReason: "stop" }]), true);
	assert.equal(shouldAutoExitOnAgentEnd(true, false, false, [{ role: "assistant", stopReason: "aborted" }]), false);
	assert.equal(shouldAutoExitOnAgentEnd(false, false, true, [{ role: "assistant", stopReason: "stop" }]), true);
	assert.equal(shouldAutoExitOnAgentEnd(false, false, true, [{ role: "assistant", stopReason: "aborted" }]), false);
	assert.equal(shouldAutoExitOnAgentEnd(false, false, false, [{ role: "assistant", stopReason: "stop" }]), false);
});
```

This must fail before implementation because the production helper still accepts only three arguments and interprets the third argument as `messages`.

- [ ] **Step 2: Add a failing shortcut/deduplication test using a fake Pi API**

Add this import at the top of `extensions/subagents/test/visible-auto-exit.test.ts`:

```ts
import visibleAutoExit from "../tools/visible-auto-exit.ts";
```

Add this test after the lifecycle test:

```ts
it("queues one graceful-return steering message for repeated shortcut presses", () => {
	const shortcuts = new Map<string, { handler: (ctx: unknown) => void }>();
	const sent: Array<{ content: string; options: unknown }> = [];
	const pi = {
		getAllTools: () => [],
		on: () => {},
		registerTool: () => {},
		registerShortcut: (key: string, options: { handler: (ctx: unknown) => void }) => shortcuts.set(key, options),
		sendUserMessage: (content: string, options: unknown) => sent.push({ content, options }),
	};
	const ctx = { ui: { setWidget: () => {} } };

	visibleAutoExit(pi as never);
	shortcuts.get("ctrl+shift+s")?.handler(ctx);
	shortcuts.get("ctrl+shift+s")?.handler(ctx);

	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]?.options, { deliverAs: "steer" });
	assert.match(sent[0]?.content ?? "", /Stop starting new searches or tool calls/);
	assert.match(sent[0]?.content ?? "", /incomplete or uncertain items/);
});
```

- [ ] **Step 3: Run the focused test and verify it fails**

Run:

```bash
node --experimental-strip-types --test extensions/subagents/test/visible-auto-exit.test.ts
```

Expected: FAIL because no `ctrl+shift+s` shortcut is registered, leaving `sent.length` equal to 0.

- [ ] **Step 4: Extend the pure exit predicate**

Change `shouldAutoExitOnAgentEnd` in `extensions/subagents/tools/visible-auto-exit-helpers.ts` to:

```ts
export function shouldAutoExitOnAgentEnd(
	autoExit: boolean,
	_userTookOver: boolean,
	gracefulReturnRequested: boolean,
	messages: Array<{ role?: string; stopReason?: string }> | undefined,
): boolean {
	if (!autoExit && !gracefulReturnRequested) return false;
	const lastAssistant = [...(messages ?? [])].reverse().find((message) => message.role === "assistant");
	return lastAssistant?.stopReason !== "aborted";
}
```

Keeping `_userTookOver` in the interface avoids unrelated lifecycle refactoring while adding the requested state explicitly.

- [ ] **Step 5: Add the graceful-return constants and state**

In `extensions/subagents/tools/visible-auto-exit.ts`, immediately after the existing widget shortcut constants, add:

```ts
const GRACEFUL_RETURN_SHORTCUT = "ctrl+shift+s";
const GRACEFUL_RETURN_SHORTCUT_LABEL = "Ctrl+Shift+S";
const GRACEFUL_RETURN_PROMPT =
	"Stop starting new searches or tool calls. Using only information already obtained, provide a concise final report for the parent agent with: completed work, main findings, and any incomplete or uncertain items. Treat that report as your final response.";
```

Inside the default extension function, after `let expanded = false;`, add:

```ts
let gracefulReturnRequested = false;
```

- [ ] **Step 6: Update both widget states with graceful-return and hard-abort hints**

In the expanded branch, replace the current `Text` content expression with:

```ts
const controls = gracefulReturnRequested
	? `${TOOL_WIDGET_SHORTCUT_LABEL} to collapse · return requested · Esc abort`
	: `${TOOL_WIDGET_SHORTCUT_LABEL} to collapse · ${GRACEFUL_RETURN_SHORTCUT_LABEL} summarize & return · Esc abort`;
box.addChild(new Text(
	`${label}${theme.fg("dim", ` — ${tools.length} available`)}${theme.fg("muted", `  (${controls})`)}\n${toolList}${deniedLine}`,
	0,
	0,
));
```

In the collapsed branch, replace the current `Text` content expression with:

```ts
const controls = gracefulReturnRequested
	? `${TOOL_WIDGET_SHORTCUT_LABEL} to expand · return requested · Esc abort`
	: `${TOOL_WIDGET_SHORTCUT_LABEL} to expand · ${GRACEFUL_RETURN_SHORTCUT_LABEL} summarize & return · Esc abort`;
box.addChild(new Text(
	`${label}${theme.fg("dim", ` — ${tools.length} tools`)}${deniedInfo}${theme.fg("muted", `  (${controls})`)}`,
	0,
	0,
));
```

Do not turn the render-only widget into a custom input component; shortcut handling remains in `registerShortcut`.

- [ ] **Step 7: Register the deduplicated steering shortcut**

Inside the existing `registerShortcut` capability guard, immediately after the tool-widget shortcut registration, add:

```ts
(pi as any).registerShortcut(GRACEFUL_RETURN_SHORTCUT, {
	description: "Summarize current work and return to parent",
	handler: (ctx: any) => {
		if (gracefulReturnRequested) return;
		gracefulReturnRequested = true;
		renderWidget(ctx);
		pi.sendUserMessage(GRACEFUL_RETURN_PROMPT, { deliverAs: "steer" });
	},
});
```

Setting the boolean before `sendUserMessage` is required so rapid repeated presses cannot enqueue duplicate messages.

- [ ] **Step 8: Pass graceful-return state into the clean-exit predicate**

Change the `agent_end` guard in `extensions/subagents/tools/visible-auto-exit.ts` from:

```ts
if (!shouldAutoExitOnAgentEnd(autoExit, userTookOver, event.messages)) return;
```

to:

```ts
if (!shouldAutoExitOnAgentEnd(autoExit, userTookOver, gracefulReturnRequested, event.messages)) return;
```

This preserves the existing `stopReason: "aborted"` protection while allowing an interactive child to close after its requested final report.

- [ ] **Step 9: Run the focused test and verify it passes**

Run:

```bash
node --experimental-strip-types --test extensions/subagents/test/visible-auto-exit.test.ts
```

Expected: all tests in `visible-auto-exit.test.ts` PASS, including one steering message after two shortcut invocations.

- [ ] **Step 10: Run all subagent tests**

Run:

```bash
npm run test:subagents
```

Expected: exit code 0 and all subagent test suites PASS.

- [ ] **Step 11: Check TypeScript diagnostics for modified source and test files**

Run LSP diagnostics on:

- `extensions/subagents/tools/visible-auto-exit.ts`
- `extensions/subagents/tools/visible-auto-exit-helpers.ts`
- `extensions/subagents/test/visible-auto-exit.test.ts`

Expected: no new errors or warnings.

- [ ] **Step 12: Commit the implementation and tests**

```bash
git add extensions/subagents/tools/visible-auto-exit.ts extensions/subagents/tools/visible-auto-exit-helpers.ts extensions/subagents/test/visible-auto-exit.test.ts
git commit -m "feat(subagents): add graceful return shortcut"
```

### Task 2: User documentation and end-to-end verification

**Files:**
- Modify: `extensions/subagents/README.md:15-20`

**Interfaces:**
- Consumes: shortcut behavior implemented in Task 1.
- Produces: user-facing documentation for `Ctrl+Shift+J`, `Ctrl+Shift+S`, and `Escape`.

- [ ] **Step 1: Correct and expand the visible-child shortcut documentation**

Replace the visible-child paragraph in `extensions/subagents/README.md` with:

```md
Visible children show their available and denied tools above the editor. Press
`Ctrl+Shift+J` to expand or collapse that widget. Press `Ctrl+Shift+S` to stop
starting new work, summarize the information already obtained, return that
report to the parent, and close cleanly. `Escape` remains an immediate abort
that leaves the child pane open. `caller_ping` returns a help request plus a
resumable session path to the parent, and `subagent_done` closes the child
explicitly. Reply with `subagent_resume` and that session path.
```

- [ ] **Step 2: Run documentation and repository whitespace checks**

Run:

```bash
git diff --check
rg -n 'Ctrl\+J|Ctrl\+Shift\+J|Ctrl\+Shift\+S|Escape' extensions/subagents/README.md extensions/subagents/tools/visible-auto-exit.ts
```

Expected: `git diff --check` exits 0; README contains no stale standalone `Ctrl+J` instruction and describes all three controls.

- [ ] **Step 3: Run the complete automated verification again**

Run:

```bash
npm run test:subagents
```

Expected: exit code 0 and all subagent tests PASS.

- [ ] **Step 4: Perform a visible-pane graceful-return smoke test**

From a supported Herdr/tmux Pi session, start a visible researcher with a task that requires multiple searches. While it is running, press `Ctrl+Shift+S` once.

Verify all observable outcomes:

```text
1. The widget changes from “Ctrl+Shift+S summarize & return” to “return requested”.
2. The child does not begin additional research after processing the steering message.
3. Its final answer contains completed work, findings, and incomplete/uncertain items.
4. The child pane closes cleanly after that answer.
5. The parent receives a subagent_visible_result containing the final report.
6. The parent automatically begins its follow-up turn.
```

If a tool is in flight, wait for that tool to return before judging steps 2-5; cooperative return intentionally does not kill the current tool.

- [ ] **Step 5: Verify hard abort remains distinct**

Start a second visible researcher, press `Escape`, and verify:

```text
1. The current assistant turn is marked aborted.
2. No graceful summary is synthesized.
3. The pane remains open for continued interaction.
```

- [ ] **Step 6: Commit the documentation**

```bash
git add extensions/subagents/README.md
git commit -m "docs(subagents): document graceful return controls"
```

- [ ] **Step 7: Review final scope**

Run:

```bash
git status --short
git diff HEAD~2 --stat
git diff HEAD~2 -- extensions/subagents/tools/visible-auto-exit.ts extensions/subagents/test/visible-auto-exit.test.ts extensions/subagents/README.md
```

Expected: only the four planned implementation files changed across the two implementation commits; pre-existing unrelated files such as the untracked `old/` directory remain untouched.
