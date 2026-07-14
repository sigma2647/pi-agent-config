# Subagent Visible-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `subagent` prefer visible Herdr/tmux execution by default and automatically fall back to synchronous execution, with a reason, when visible startup is unavailable or fails.

**Architecture:** A small pure dispatcher in `visible-helpers.ts` owns the visible-first policy and returns an explicit dispatch mode. Both tool registrations reuse one execution path in `index.ts`; the existing visible watcher remains unchanged. Visible startup cleanup is isolated in `visible-runtime.ts` so fallback never leaks temporary files or panes.

**Tech Stack:** TypeScript, Node.js `node:test`, Pi Extension API, TypeBox, Herdr, tmux.

## Global Constraints

- `subagent` defaults to visible execution in TUI mode; `visible: false` forces synchronous execution.
- Non-TUI mode, missing mux targets, and visible startup exceptions automatically fall back synchronously and report the reason.
- Once a visible child has started, later child failure or interruption must never trigger a second synchronous execution.
- `subagent_visible` remains registered for compatibility and uses the same startup-fallback policy.
- Do not add a new tool, mux backend, dependency, task-duration heuristic, or unrelated Herdr detection change.
- Every relative TypeScript import ends in `.ts`.

---

### Task 1: Add the Tested Visible-First Dispatch Policy

**Files:**
- Modify: `extensions/subagents/visible-helpers.ts`
- Test: `extensions/subagents/test/visible-helpers.test.ts`

**Interfaces:**
- Produces: `dispatchVisibleFirst<TVisible, TSync>(options): Promise<VisibleFirstDispatch<TVisible, TSync>>`
- Produces: `VisibleFirstDispatch<TVisible, TSync>` with `dispatchMode`, `value`, and optional `fallbackReason`.
- Consumes: existing `DetectedVisibleTarget`.

- [ ] **Step 1: Write failing dispatch-policy tests**

Add `dispatchVisibleFirst` to the existing import in `extensions/subagents/test/visible-helpers.test.ts`, then append:

```ts
it("prefers visible execution in TUI mode", async () => {
	let syncCalls = 0;
	const result = await dispatchVisibleFirst({
		mode: "tui",
		preferVisible: true,
		target: { backend: "herdr", paneId: "w1:p2" },
		launchVisible: async () => "visible",
		runSync: async () => { syncCalls++; return "sync"; },
	});
	assert.deepEqual(result, { dispatchMode: "visible", value: "visible" });
	assert.equal(syncCalls, 0);
});

it("falls back once when visible execution is unavailable", async () => {
	for (const testCase of [
		{ mode: "rpc", target: { backend: "herdr" as const, paneId: "w1:p2" }, reason: /TUI mode/ },
		{ mode: "tui", target: null, reason: /Herdr\/tmux target/ },
	]) {
		let syncCalls = 0;
		const result = await dispatchVisibleFirst({
			mode: testCase.mode,
			preferVisible: true,
			target: testCase.target,
			launchVisible: async () => "visible",
			runSync: async () => { syncCalls++; return "sync"; },
		});
		assert.equal(result.dispatchMode, "sync-fallback");
		assert.match(result.fallbackReason ?? "", testCase.reason);
		assert.equal(result.value, "sync");
		assert.equal(syncCalls, 1);
	}
});

it("falls back once when visible startup throws", async () => {
	let syncCalls = 0;
	const result = await dispatchVisibleFirst({
		mode: "tui",
		preferVisible: true,
		target: { backend: "tmux", paneId: "%7" },
		launchVisible: async () => { throw new Error("split failed"); },
		runSync: async () => { syncCalls++; return "sync"; },
	});
	assert.equal(result.dispatchMode, "sync-fallback");
	assert.match(result.fallbackReason ?? "", /split failed/);
	assert.equal(syncCalls, 1);
});

it("runs synchronously without calling visible when explicitly disabled", async () => {
	let visibleCalls = 0;
	const result = await dispatchVisibleFirst({
		mode: "tui",
		preferVisible: false,
		target: { backend: "herdr", paneId: "w1:p2" },
		launchVisible: async () => { visibleCalls++; return "visible"; },
		runSync: async () => "sync",
	});
	assert.deepEqual(result, { dispatchMode: "sync", value: "sync" });
	assert.equal(visibleCalls, 0);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --experimental-strip-types --test --test-name-pattern="prefers visible|falls back once|explicitly disabled" extensions/subagents/test/visible-helpers.test.ts
```

Expected: FAIL because `dispatchVisibleFirst` is not exported.

- [ ] **Step 3: Implement the minimal policy helper**

Add to `extensions/subagents/visible-helpers.ts`:

```ts
export type VisibleFirstDispatch<TVisible, TSync> =
	| { dispatchMode: "visible"; value: TVisible; fallbackReason?: never }
	| { dispatchMode: "sync"; value: TSync; fallbackReason?: never }
	| { dispatchMode: "sync-fallback"; value: TSync; fallbackReason: string };

export async function dispatchVisibleFirst<TVisible, TSync>(options: {
	mode: string;
	preferVisible: boolean;
	target: DetectedVisibleTarget | null;
	launchVisible: (target: DetectedVisibleTarget) => Promise<TVisible>;
	runSync: () => Promise<TSync>;
}): Promise<VisibleFirstDispatch<TVisible, TSync>> {
	if (!options.preferVisible) {
		return { dispatchMode: "sync", value: await options.runSync() };
	}

	let fallbackReason: string;
	if (options.mode !== "tui") {
		fallbackReason = `Visible subagents require TUI mode (current: ${options.mode}).`;
	} else if (!options.target) {
		fallbackReason = "No supported Herdr/tmux target is available.";
	} else {
		try {
			return {
				dispatchMode: "visible",
				value: await options.launchVisible(options.target),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			fallbackReason = `Visible subagent startup failed: ${message}`;
		}
	}

	return {
		dispatchMode: "sync-fallback",
		fallbackReason,
		value: await options.runSync(),
	};
}
```

The helper catches only the `launchVisible()` promise. After that promise resolves, watcher-delivered child failures are outside this call and cannot trigger fallback.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command again.

Expected: 4 tests PASS and 0 FAIL.

- [ ] **Step 5: Commit the dispatch policy**

```bash
git add extensions/subagents/visible-helpers.ts extensions/subagents/test/visible-helpers.test.ts
git commit -m "feat(subagents): add visible-first dispatch policy"
```

---

### Task 2: Clean Up Failed Visible Starts

**Files:**
- Modify: `extensions/subagents/visible-runtime.ts`
- Modify: `extensions/subagents/index.ts:625-715`
- Test: `extensions/subagents/test/visible-runtime.test.ts`

**Interfaces:**
- Produces: `cleanupFailedVisibleLaunch(tempDir, target, closePane?)`.
- Changes: `launchVisibleSubagent()` wraps pre-start work and invokes the cleanup helper before rethrowing.
- Consumes: existing `VisibleRunTarget` and `closeVisiblePane()`.

- [ ] **Step 1: Write a failing cleanup test**

Import `existsSync` alongside the current fs imports and add `cleanupFailedVisibleLaunch` to the runtime import. Append:

```ts
it("cleans temporary files and a created pane after startup failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-failed-launch-"));
	tempDirs.push(dir);
	writeFileSync(join(dir, "task.md"), "task");
	let closedPane: string | null = null;

	cleanupFailedVisibleLaunch(
		dir,
		{ backend: "herdr", paneId: "w1:p9" },
		(target) => { closedPane = target.paneId; },
	);

	assert.equal(closedPane, "w1:p9");
	assert.equal(existsSync(dir), false);
});

it("does not let cleanup errors replace the startup error", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-failed-cleanup-"));
	tempDirs.push(dir);
	assert.doesNotThrow(() => cleanupFailedVisibleLaunch(
		dir,
		{ backend: "tmux", paneId: "%9" },
		() => { throw new Error("close failed"); },
	));
	assert.equal(existsSync(dir), false);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
node --experimental-strip-types --test --test-name-pattern="startup failure|cleanup errors" extensions/subagents/test/visible-runtime.test.ts
```

Expected: FAIL because `cleanupFailedVisibleLaunch` is not exported.

- [ ] **Step 3: Implement the cleanup helper**

Add `rmSync` to the fs import in `extensions/subagents/visible-runtime.ts`, then add:

```ts
export function cleanupFailedVisibleLaunch(
	tempDir: string,
	target: VisibleRunTarget | null,
	closePane: (target: VisibleRunTarget) => void = closeVisiblePane,
): void {
	if (target) {
		try { closePane(target); } catch {}
	}
	try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
}
```

- [ ] **Step 4: Wrap `launchVisibleSubagent()` startup in cleanup**

Import `cleanupFailedVisibleLaunch` in `extensions/subagents/index.ts`. After creating `tempDir`, declare:

```ts
let target: VisibleRunTarget | null = null;
```

Wrap prompt/task writes, script construction, pane creation, `launchVisibleRun()`, run registration, watcher startup, and return in `try`. Change the existing declaration to assignment:

```ts
target = createVisiblePane(detected, cwd, `${agent.name}:${id}`, initialCommand);
```

At the end add:

```ts
} catch (error) {
	visibleSubagents.delete(id);
	cleanupFailedVisibleLaunch(tempDir, target);
	throw error;
}
```

Do not include watcher-reported child errors in this `try/catch`; the catch only covers work before `launchVisibleSubagent()` returns.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run the Step 2 command again.

Expected: 2 tests PASS and 0 FAIL.

- [ ] **Step 6: Commit startup cleanup**

```bash
git add extensions/subagents/visible-runtime.ts extensions/subagents/index.ts extensions/subagents/test/visible-runtime.test.ts
git commit -m "fix(subagents): clean failed visible starts"
```

---

### Task 3: Route Both Tools Through Visible-First Execution

**Files:**
- Modify: `extensions/subagents/index.ts:65-95,625-715,1017-1284`
- Test: `extensions/subagents/test/visible-helpers.test.ts` (dispatch behavior supplied by Task 1)

**Interfaces:**
- Consumes: `dispatchVisibleFirst()` from Task 1.
- Produces: one internal `executeSubagent(params, signal, onUpdate, ctx, preferVisible)` function used by both registered tools.
- Produces details with `dispatchMode: "visible" | "sync" | "sync-fallback"` and optional `fallbackReason`.

- [ ] **Step 1: Re-run the dispatch contract before integration**

```bash
node --experimental-strip-types --test --test-name-pattern="prefers visible|falls back once|explicitly disabled" extensions/subagents/test/visible-helpers.test.ts
```

Expected: PASS. These tests are the red/green contract written before the tool integration and prove visible preference, startup fallback, single synchronous execution, and explicit synchronous execution.

- [ ] **Step 2: Define unified result details**

Replace the current `Details` interface in `extensions/subagents/index.ts` with:

```ts
interface VisibleStartedDetails {
	dispatchMode: "visible";
	id: string;
	name: string;
	agent: string;
	backend: VisibleBackend;
	paneId?: string;
	interactive: boolean;
	status: "started";
}

interface SyncDetails {
	dispatchMode: "sync" | "sync-fallback";
	results: AgentResult[];
	fallbackReason?: string;
}

type Details = VisibleStartedDetails | SyncDetails;
```

Import `dispatchVisibleFirst` and `type DetectedVisibleTarget` from `visible-helpers.ts`.

- [ ] **Step 3: Extract the existing synchronous body once**

Inside the extension factory, add a local `runSync(...)` helper containing the current `subagent.execute()` model lookup, `liveResult`, semaphore, progress callback, `runSubagent()`, and final `AgentToolResult` construction. Its returned details must include:

```ts
{
	dispatchMode,
	results: [result],
	...(fallbackReason ? { fallbackReason } : {}),
}
```

Do not duplicate the synchronous body in the two tool registrations.

- [ ] **Step 4: Add the shared visible-first executor**

Inside the extension factory add `executeSubagent(...)` that performs the current parameter, agent, and self-spawn validation once, resolves `cwd`, and calls:

```ts
const dispatch = await dispatchVisibleFirst({
	mode: ctx.mode,
	preferVisible,
	target: ctx.mode === "tui" && preferVisible ? detectVisibleTarget(cwd) : null,
	launchVisible: (target) => launchVisibleSubagent(pi, agent, params.task, cwd, target),
	runSync: () => runSync(agent, params, cwd, signal, onUpdate, ctx),
});
```

Update `launchVisibleSubagent()` to accept an optional already-detected target:

```ts
detected = detectVisibleTarget(cwd),
```

Map dispatch results as follows:

- `visible`: return current started content and `VisibleStartedDetails` with `dispatchMode: "visible"`;
- `sync`: return the synchronous result with `dispatchMode: "sync"`;
- `sync-fallback`: prefix content with `Visible execution unavailable; used synchronous fallback: ${fallbackReason}\n\n` and add `dispatchMode` plus `fallbackReason` to details.

The dispatcher must invoke `runSync()` exactly once per synchronous result.

- [ ] **Step 5: Update the `subagent` schema and execution**

Add the direct semantic boolean:

```ts
visible: Type.Optional(Type.Boolean({
	description: "Prefer a visible Herdr/tmux pane; defaults to true. Set false for synchronous hidden execution.",
})),
```

Replace its execution body with:

```ts
return executeSubagent(params, signal, onUpdate, ctx, params.visible !== false);
```

- [ ] **Step 6: Reuse the executor from `subagent_visible`**

Replace its execution body with:

```ts
return executeSubagent(params, signal, onUpdate, ctx, true);
```

Keep its existing parameter schema for compatibility; do not add a second preference option.

- [ ] **Step 7: Support both result shapes in renderers**

In `subagent.renderResult()`, first handle `details.dispatchMode === "visible"` using the existing visible started renderer. For synchronous details, keep the existing progress boxes; when `dispatchMode === "sync-fallback"`, prepend a warning line containing `fallbackReason`.

In `subagent_visible.renderResult()`, retain the current started renderer for `dispatchMode === "visible"`. For `sync` or `sync-fallback`, render the returned text content directly and prefix the fallback reason when present. Do not assume every result has `status: "started"` after this change.

- [ ] **Step 8: Route `/subagent-visible` through its tool**

Import `buildVisibleSubagentUserMessage` from `visible-helpers.ts`, then replace the command's direct `launchVisibleSubagent()` call with:

```ts
pi.sendUserMessage(buildVisibleSubagentUserMessage(parsed.agentName, parsed.task));
```

This ensures command invocations receive the same fallback behavior instead of bypassing the tool executor.

- [ ] **Step 9: Run the complete subagent tests**

```bash
npm run test:subagents
```

Expected: all tests PASS, 0 FAIL.

- [ ] **Step 10: Commit unified routing**

```bash
git add extensions/subagents/index.ts
git commit -m "feat(subagents): prefer visible execution by default"
```

---

### Task 4: Update Prompts, Documentation, and Verify Both Paths

**Files:**
- Modify: `extensions/subagents/index.ts:1017-1187`
- Modify: `extensions/subagents/README.md`
- Modify: `AGENTS.md:72`

**Interfaces:**
- Documents: canonical `subagent` visible-first behavior, explicit `visible: false`, and automatic synchronous fallback.
- Preserves: visible lifecycle controls and agent discovery precedence.

- [ ] **Step 1: Update tool guidance**

Change `subagent` description/guidelines to state:

```text
Use `subagent` as the normal delegation entry point. In TUI mode it prefers a visible Herdr/tmux pane and returns immediately; when visible startup is unavailable it automatically runs synchronously and reports why. After a visible start, wait for the later completion message and do not invent results.
```

Remove the old instruction that ordinary delegated work should prefer synchronous `subagent`. Describe `subagent_visible` as a compatibility alias that also uses visible-first startup fallback.

- [ ] **Step 2: Update extension documentation**

In `extensions/subagents/README.md`, replace the index bullet with:

```md
- `index.ts` — registers visible-first `subagent`, compatibility `subagent_visible`, and visible lifecycle tools. Visible startup failures automatically fall back to synchronous execution with a reported reason.
```

Add one sentence documenting `visible: false` for an explicitly synchronous hidden call.

- [ ] **Step 3: Update repository instructions**

Replace the opening of the subagents paragraph in `AGENTS.md` with:

```md
**subagents uses one visible-first default.** `subagent` is the normal delegation entry point: in TUI mode it tries Herdr/tmux visible execution first and returns immediately; if visible startup is unavailable or fails, it automatically falls back to the isolated synchronous child and reports the reason. Pass `visible: false` only when synchronous hidden execution is explicitly required. `subagent_visible` remains a compatibility entry point with the same startup fallback behavior.
```

Keep the existing auto-exit, interrupt, resume, widget, and discovery text after it.

- [ ] **Step 4: Run automated verification**

```bash
npm run test:subagents
git diff --check
```

Expected: all tests PASS; `git diff --check` exits 0.

- [ ] **Step 5: Run TypeScript diagnostics**

Run LSP diagnostics for:

- `extensions/subagents/index.ts`
- `extensions/subagents/visible-helpers.ts`
- `extensions/subagents/visible-runtime.ts`

If the workspace has no TypeScript LSP, record that fact and rely on the Node type-stripping test suite plus the smoke tests; do not claim LSP success.

- [ ] **Step 6: Verify visible execution in the current Herdr session**

Reload the extension, then invoke:

```text
subagent(agent="scout", task="Reply only with: visible smoke ok")
```

Expected:

1. tool returns a visible started acknowledgement immediately;
2. a Herdr/tmux pane is created;
3. the child later delivers `visible smoke ok`;
4. no synchronous `(running...)` progress appears.

- [ ] **Step 7: Verify forced synchronous execution**

Invoke:

```text
subagent(agent="scout", task="Reply only with: sync smoke ok", visible=false)
```

Expected: no pane is created; the tool waits and returns `sync smoke ok` with `dispatchMode: "sync"`.

- [ ] **Step 8: Verify automatic no-mux fallback policy**

Run the dispatch-policy focused test from Task 1 and confirm the no-target case returns `dispatchMode: "sync-fallback"` with a Herdr/tmux reason. Do not launch a second real Pi process merely to simulate a headless parent.

- [ ] **Step 9: Commit documentation**

```bash
git add extensions/subagents/index.ts extensions/subagents/README.md AGENTS.md
git commit -m "docs(subagents): document visible-first fallback"
```

- [ ] **Step 10: Final repository check**

```bash
git status --short
git log -n 6 --oneline
```

Expected: working tree clean and the implementation commits are present after the revised design/plan commits.
