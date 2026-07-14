# Subagent 默认可见优先实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Herdr pane 误判，并让 `subagent` 在存在 Herdr/tmux 时异步可见执行、仅在无 live mux 时同步回退。

**Architecture:** 检测层优先信任 Herdr 注入的当前进程 pane ID，并保留原有命令探测兜底。执行层通过一个小型、可测试的 visible-first 调度函数选择现有 `launchVisibleSubagent()` 或 `runSubagent()`，不捕获 visible 启动错误；`subagent_visible` 继续严格要求 live mux。

**Tech Stack:** TypeScript、Node.js `node:test`、Pi Extension API、Herdr CLI、tmux。

## 全局约束

- 不增加新的复用器后端或依赖。
- 不增加用户可见模式参数。
- 已检测到 mux 后的启动错误必须直接暴露，不得同步回退。
- `subagent_visible` 保持严格可见语义。
- `/subagent` 继续调用 `subagent`，自动继承 visible-first 行为。
- 所有相对 TypeScript import 必须带 `.ts` 后缀。

---

### Task 1：修复 Herdr 当前进程 pane 检测

**Files:**
- Modify: `extensions/subagents/visible-helpers.ts`
- Modify: `extensions/subagents/visible-runtime.ts:38-60`
- Test: `extensions/subagents/test/visible-helpers.test.ts`

**Interfaces:**
- Produces: `resolveHerdrPaneId(args): string | null`
- Consumes: 现有 `HerdrPaneInfo`、`isFocusedHerdrPane()` 和 `detectVisibleTarget()`。

- [ ] **Step 1：先写失败测试**

在 `extensions/subagents/test/visible-helpers.test.ts` 的 import 中加入 `resolveHerdrPaneId`，并增加：

```ts
it("uses the Herdr pane inherited by the current process even when it is unfocused", () => {
	assert.equal(resolveHerdrPaneId({
		commandAvailable: true,
		herdrEnv: "1",
		envPaneId: " w10:p1K ",
		currentPane: { pane_id: "w10:p1K", focused: false },
	}), "w10:p1K");
});

it("requires a live Herdr command before trusting inherited pane identity", () => {
	assert.equal(resolveHerdrPaneId({
		commandAvailable: false,
		herdrEnv: "1",
		envPaneId: "w10:p1K",
		currentPane: { pane_id: "w10:p1K", focused: true },
	}), null);
});

it("falls back to a focused pane when no inherited Herdr identity exists", () => {
	assert.equal(resolveHerdrPaneId({
		commandAvailable: true,
		currentPane: { pane_id: "w2:p3", focused: true },
	}), "w2:p3");
	assert.equal(resolveHerdrPaneId({
		commandAvailable: true,
		currentPane: { pane_id: "w2:p3", focused: false },
	}), null);
});
```

- [ ] **Step 2：运行测试并确认 RED**

Run:

```bash
node --experimental-strip-types --test --test-name-pattern="Herdr pane inherited|live Herdr command|focused pane" extensions/subagents/test/*.test.ts
```

Expected: FAIL，提示 `resolveHerdrPaneId` 尚未导出。

- [ ] **Step 3：实现最小纯函数**

在 `extensions/subagents/visible-helpers.ts` 中加入：

```ts
export function resolveHerdrPaneId(args: {
	commandAvailable: boolean;
	herdrEnv?: string;
	envPaneId?: string;
	currentPane?: HerdrPaneInfo | null;
}): string | null {
	if (!args.commandAvailable) return null;
	const envPaneId = args.envPaneId?.trim();
	if (args.herdrEnv === "1" && envPaneId) return envPaneId;
	return isFocusedHerdrPane(args.currentPane ?? null)
		? args.currentPane!.pane_id
		: null;
}
```

在 `extensions/subagents/visible-runtime.ts` 中 import `resolveHerdrPaneId`，并把现有 Herdr 检测块替换为：

```ts
const herdrAvailable = hasCommand("herdr");
let currentHerdrPane = null;
const inheritedHerdrPane = process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID?.trim();
if (herdrAvailable && !inheritedHerdrPane) {
	try {
		currentHerdrPane = parseHerdrPaneCurrent(run(["herdr", "pane", "current"]));
	} catch {}
}
const herdrPaneId = resolveHerdrPaneId({
	commandAvailable: herdrAvailable,
	herdrEnv: process.env.HERDR_ENV,
	envPaneId: process.env.HERDR_PANE_ID,
	currentPane: currentHerdrPane,
});
```

删除 `visible-runtime.ts` 中不再直接使用的 `isFocusedHerdrPane` import。

- [ ] **Step 4：运行测试并确认 GREEN**

Run:

```bash
node --experimental-strip-types --test --test-name-pattern="Herdr pane inherited|live Herdr command|focused pane" extensions/subagents/test/*.test.ts
```

Expected: 3 个新增测试 PASS。

- [ ] **Step 5：在当前 Herdr 会话验证真实检测**

Run:

```bash
node --experimental-strip-types --no-warnings -e 'import("./extensions/subagents/visible-runtime.ts").then(m => console.log(JSON.stringify(m.detectVisibleTarget(process.cwd()))))'
```

Expected: 输出类似 `{"backend":"herdr","paneId":"w10:p1K"}`，即使 `herdr pane current` 的 `focused` 为 `false`。

- [ ] **Step 6：提交检测修复**

```bash
git add extensions/subagents/visible-helpers.ts extensions/subagents/visible-runtime.ts extensions/subagents/test/visible-helpers.test.ts
git commit -m "fix(subagents): trust inherited Herdr pane identity"
```

---

### Task 2：让 `subagent` 使用 visible-first 调度

**Files:**
- Modify: `extensions/subagents/visible-helpers.ts`
- Modify: `extensions/subagents/index.ts:625-668,1017-1173,1175-1279`
- Test: `extensions/subagents/test/visible-helpers.test.ts`

**Interfaces:**
- Produces: `runVisibleFirst(target, launchVisible, runSync): Promise<TVisible | TSync>`。
- Changes: `launchVisibleSubagent(..., detected?)` 可接收已经检测到的 `DetectedVisibleTarget`，避免重复检测。
- Preserves: `subagent_visible` 省略 `detected` 参数时仍执行严格检测。

- [ ] **Step 1：先写 visible-first 调度失败测试**

在 `extensions/subagents/test/visible-helpers.test.ts` import `runVisibleFirst`，增加：

```ts
it("prefers visible execution when a mux target exists", async () => {
	let syncCalls = 0;
	const result = await runVisibleFirst(
		{ backend: "herdr", paneId: "w10:p1K" },
		async (target) => `visible:${target.paneId}`,
		async () => { syncCalls++; return "sync"; },
	);
	assert.equal(result, "visible:w10:p1K");
	assert.equal(syncCalls, 0);
});

it("falls back to sync only when no mux target exists", async () => {
	let visibleCalls = 0;
	const result = await runVisibleFirst(
		null,
		async () => { visibleCalls++; return "visible"; },
		async () => "sync",
	);
	assert.equal(result, "sync");
	assert.equal(visibleCalls, 0);
});

it("surfaces visible launch failures without running sync fallback", async () => {
	let syncCalls = 0;
	await assert.rejects(
		runVisibleFirst(
			{ backend: "herdr", paneId: "w10:p1K" },
			async () => { throw new Error("split failed"); },
			async () => { syncCalls++; return "sync"; },
		),
		/split failed/,
	);
	assert.equal(syncCalls, 0);
});
```

- [ ] **Step 2：运行测试并确认 RED**

Run:

```bash
node --experimental-strip-types --test --test-name-pattern="prefers visible execution|falls back to sync|visible launch failures" extensions/subagents/test/*.test.ts
```

Expected: FAIL，提示 `runVisibleFirst` 尚未导出。

- [ ] **Step 3：实现最小调度函数**

在 `extensions/subagents/visible-helpers.ts` 中加入：

```ts
export async function runVisibleFirst<TVisible, TSync>(
	target: DetectedVisibleTarget | null,
	launchVisible: (target: DetectedVisibleTarget) => Promise<TVisible>,
	runSync: () => Promise<TSync>,
): Promise<TVisible | TSync> {
	return target ? launchVisible(target) : runSync();
}
```

该函数不得加入 `try/catch`，确保 detected-mux 启动错误不会触发同步回退。

- [ ] **Step 4：让 visible launcher 接收已检测目标**

在 `extensions/subagents/index.ts` import `DetectedVisibleTarget` 和 `runVisibleFirst`，将函数签名改为：

```ts
async function launchVisibleSubagent(
	pi: ExtensionAPI,
	agent: AgentConfig,
	task: string,
	cwd: string,
	detected: DetectedVisibleTarget | null = detectVisibleTarget(cwd),
): Promise<VisibleSubagentRun> {
	if (!detected) {
		throw new Error("Visible subagent mode requires a supported live mux target (Herdr or tmux).");
	}
```

函数其余生命周期保持不变。

- [ ] **Step 5：把 `subagent.execute` 包装为 visible-first**

在 agent/self-spawn 校验后，用以下完整代码替换原有仅同步执行块：

```ts
const cwd = resolveAgentCwd(ctx.cwd, params.cwd, agent.cwd);
return runVisibleFirst(
	detectVisibleTarget(cwd),
	async (target) => {
		const run = await launchVisibleSubagent(pi, agent, params.task, cwd, target);
		return {
			content: [{
				type: "text",
				text: `Started ${run.interactive ? "interactive" : "autonomous"} visible subagent "${run.name}" in ${run.target.backend} pane ${run.target.paneId}.`,
			}],
			details: {
				id: run.id,
				name: run.name,
				agent: run.agent,
				backend: run.target.backend,
				paneId: run.target.paneId,
				interactive: run.interactive,
				status: "started",
			},
		};
	},
	async () => {
		const { provider, modelId } = splitModel(agent.model || "");
		const registry = (ctx as any).modelRegistry;
		const contextWindow = provider && modelId && registry?.find
			? registry.find(provider, modelId)?.contextWindow
			: undefined;

		const liveResult: AgentResult = {
			agent: params.agent,
			task: params.task,
			output: "",
			exitCode: -1,
			model: agent.model,
			contextWindow,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			progress: {
				agent: params.agent,
				status: "running" as const,
				task: params.task,
				recentTools: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 0,
				lastMessage: "",
			},
		};

		const result = await semaphore.run(() =>
			runSubagent(
				agent,
				params.task,
				cwd,
				signal,
				(progress, usage) => {
					liveResult.progress = progress;
					liveResult.usage = { ...usage };
					onUpdate?.({
						content: [{ type: "text", text: "(running...)" }],
						details: { results: [liveResult] },
					});
				},
			),
		);

		result.contextWindow = contextWindow;
		const isError = result.exitCode !== 0 || !!result.progress.error;
		return {
			content: [{ type: "text", text: result.output || "(no output)" }],
			details: { results: [result] },
			...(isError ? { isError: true } : {}),
		};
	},
);
```

`runVisibleFirst()` 不捕获异常，因此 `launchVisibleSubagent()` 失败会直接向上传播，不会执行同步回调。

- [ ] **Step 6：让 `subagent` renderer 支持 visible started 结果**

在原 `details.results` 判断之前识别：

```ts
const visibleDetails = result.details as {
	name?: string;
	backend?: VisibleBackend;
	paneId?: string;
	interactive?: boolean;
	status?: string;
} | undefined;
if (visibleDetails?.status === "started") {
	const mode = visibleDetails.interactive ? "interactive" : "autonomous";
	return new Text(
		`${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(visibleDetails.name ?? "subagent"))} ${theme.fg("dim", `— ${mode} · ${visibleDetails.backend}:${visibleDetails.paneId}`)}`,
		0,
		0,
	);
}
```

保留原同步进度 renderer。`subagent_visible` 的 execute 和 renderer 继续严格调用 `launchVisibleSubagent()`，不传目标时由其自行检测并在无 mux 时抛错。

- [ ] **Step 7：更新工具提示词**

将 `subagent` 描述改为明确说明：默认在 Herdr/tmux pane 中异步启动并立即返回；没有 live mux 时才同步执行。指导中要求 visible started 后等待异步结果，不得编造结果。

将 `subagent_visible` 第一条指导改为：它是需要严格可见执行、且不允许同步回退时使用的显式工具；删除“ordinary delegated work, prefer subagent”造成的旧语义歧义。

`/subagent` 已通过 `buildSubagentUserMessage()` 调用 `subagent`，不增加第二套命令逻辑。

- [ ] **Step 8：运行调度测试并确认 GREEN**

Run:

```bash
node --experimental-strip-types --test --test-name-pattern="prefers visible execution|falls back to sync|visible launch failures" extensions/subagents/test/*.test.ts
```

Expected: 3 个调度测试 PASS。

- [ ] **Step 9：提交 visible-first 行为**

```bash
git add extensions/subagents/visible-helpers.ts extensions/subagents/index.ts extensions/subagents/test/visible-helpers.test.ts
git commit -m "feat(subagents): prefer visible execution"
```

---

### Task 3：同步文档并完成回归验证

**Files:**
- Modify: `extensions/subagents/README.md`
- Modify: `AGENTS.md`
- Verify: `extensions/subagents/index.ts`
- Verify: `extensions/subagents/visible-runtime.ts`

**Interfaces:**
- Documents: `subagent` visible-first + sync fallback；`subagent_visible` strict visible。
- Preserves: 所有既有 CLI、agent frontmatter 和 visible lifecycle 接口。

- [ ] **Step 1：更新扩展 README**

把：

```md
- `index.ts` — registers synchronous `subagent` and visible-pane tools.
```

改为：

```md
- `index.ts` — registers visible-first `subagent`, strict `subagent_visible`, and visible-pane lifecycle tools. `subagent` falls back to synchronous execution only when no supported live mux is available.
```

- [ ] **Step 2：更新 AGENTS.md 的 subagent 约定**

把“`subagent` runs an isolated child and returns its result synchronously”改为以下语义：

```md
`subagent` is visible-first: in Herdr/tmux it returns immediately and delivers the result later; without a supported live mux it falls back to the isolated synchronous child. `subagent_visible` is the strict visible-only entry point and never falls back synchronously.
```

保留后续 auto-exit、interrupt、resume 和 graceful return 说明。

- [ ] **Step 3：运行完整自动测试**

Run:

```bash
npm run test:subagents
```

Expected: 全部测试 PASS，0 FAIL。

- [ ] **Step 4：运行静态诊断和 diff 检查**

Run:

```bash
git diff --check
```

Expected: exit 0，无 whitespace error。

对以下文件运行 LSP diagnostics：

- `extensions/subagents/index.ts`
- `extensions/subagents/visible-helpers.ts`
- `extensions/subagents/visible-runtime.ts`

Expected: 无新增 error。

- [ ] **Step 5：真实 Herdr smoke test**

在当前 Herdr 会话重新加载扩展后调用一个短任务：

```text
subagent(agent="scout", task="Reply only with: visible smoke ok")
```

Expected:

1. `subagent` 立即返回 started acknowledgement；
2. 在当前 `HERDR_PANE_ID` 旁创建可见 pane；
3. 子 agent 完成后异步回传结果；
4. 不出现同步 `(running...)` 进度。

- [ ] **Step 6：无 mux 回退 smoke test**

Run:

```bash
env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u TMUX -u TMUX_PANE \
	node --experimental-strip-types --no-warnings -e 'import("./extensions/subagents/visible-runtime.ts").then(m => console.log(m.detectVisibleTarget(process.cwd())))'
```

Expected: 输出 `null`。随后由 Task 2 的 `falls back to sync only when no mux target exists` 自动测试证明该状态选择同步回调。

- [ ] **Step 7：提交文档**

```bash
git add extensions/subagents/README.md AGENTS.md
git commit -m "docs(subagents): document visible-first execution"
```

- [ ] **Step 8：最终状态确认**

Run:

```bash
git status --short
git log -n 5 --oneline
```

Expected: 工作区干净；最新提交依次包含 Herdr 检测修复、visible-first 行为和文档同步。
