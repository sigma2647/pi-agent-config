# Subagents 交互能力借鉴实施计划

> **日期：** 2026-08-26
> **来源：** 借鉴 [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents)（tmux-only 平行 fork）与 `/home/lawrence/repo/repo-llm/pi-config/extensions/ask-user-question.ts`

> **For agentic workers:** 每个 Task 用 checkbox（`- [ ]`）跟踪，按顺序执行。Task 之间有依赖：3 依赖 1 的快照文件，4 依赖 3 的按名寻址。

**Goal:** 补齐三条「agent 卡住时能问」的通道（父→人、子→父、按名寻址的双向消息），并修复 `subagent_resume` 的沙箱重放缺口。

**Architecture:** 本仓库的 `extensions/subagents` 已是 HazAT v3.7.2 的 fork 且领先于上游（herdr 支持、模型池 + 429 回退、context-files、system-prompt mode）。amos 的 fork 是**平行分支不是升级**，因此只做定点移植，不整体合并。新增的 `ask_user_question` 作为独立 extension，不进 subagents 包。

**Tech Stack:** TypeScript（`--experimental-strip-types`）、`@earendil-works/pi-coding-agent` 0.79.10、`@mariozechner/pi-tui`、`typebox`、`node:test`。

## Global Constraints

- 直接在 `/home/lawrence/pi-agent-config` 工作；不创建 git worktree。
- **不收窄多路复用器支持。** herdr / cmux / tmux / zellij / wezterm 全部保留（AGENTS.md：existing working code has low marginal maintenance）。
- **不动模型层。** 保留 `resolveEffectiveModelWithPool` 的 DeepSeek 模型池与 429 冷却逻辑；不引入 amos 硬编码的 `glm-5.3`。
- 不删除 `/plan`、`/iterate` 命令，不删除 `subagent_interrupt`（Task 3 只在其上叠加 `subagent_message`，见该 Task 的取舍说明）。
- 不新增运行时依赖。
- 保持 `subagent` 的 fire-and-forget 语义与 steer 投递路径不变。
- 每个 Task 单独提交，只 `git add` 该 Task「Files」里列出的文件；不碰无关的已有未跟踪文件。
- 所有相对 import 以 `.ts` 结尾（AGENTS.md 硬约束）。

## 已核实的现状基线

| 事实 | 证据 | 置信度 |
| --- | --- | --- |
| `subagent_resume` 构造的命令只有 `pi --session <path> -e subagent-done.ts`，无 `--tools` / `--model` / `--system-prompt` / `PI_DENY_TOOLS` | `extensions/subagents/pi-extension/subagents/index.ts:2376-2420` | 高 |
| `launchSubagent`（spawn 路径）有完整 allowlist 与 env 注入 | 同上 `:1372`、`:1583`、`:1595-1616` | 高 |
| 工具 `execute` 的 `ctx: ExtensionContext` 含完整 `ui: ExtensionUIContext`（有 `custom` / `editor`） | `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:208-210`、`:116`、`:134` | 高 |
| `hasUI` 在 TUI **和 RPC** 模式都为 true；`custom` 是 terminal-only，需用 `mode === "tui"` 守卫 | 同上 `:211-214` 的注释 | 高 |
| 仓库无 `ask_user_question`、无 name registry、无 loadout 快照、无 `PI_SUBAGENT_ALLOWED` | 全仓 grep 无命中 | 高 |
| extension 注册方式为 root `package.json` 的 `pi.extensions` 数组 | `package.json:10` | 高 |

---

### Task 1: 用 loadout 快照修复 `subagent_resume` 的沙箱重放缺口

这是 **bug 不是特性**：一个 `tools: read, grep` 的只读 scout，resume 回来是完整工具集 + 默认模型。同时它是 Task 3 的地基。

按 AGENTS.md 的 SSOT 判据：spawn 与 resume 两处必须同步变化才正确 → 该知识只能有一个归属地。

**Files:**
- Modify: `extensions/subagents/pi-extension/subagents/index.ts`
- Modify: `extensions/subagents/test/test.ts`
- Modify: `extensions/subagents/README.md`

**Interfaces:**
- Produces: `<subagentSessionFile>.loadout.json` —— spawn 时写入的已解析装载快照。
- Consumes: `subagent_resume` 读取该快照重建受限进程。

- [ ] **Step 1: 记录 RED baseline**

```bash
cd extensions/subagents
rg -n -- '--tools|PI_DENY_TOOLS|--model|--system-prompt' pi-extension/subagents/index.ts | awk -F: '$1 > 2296 && $1 < 2460'
```

预期：**无输出**。这就是缺口的证据 —— resume 的 execute 体（`:2296` 起）里一个受限参数都没有。把这条记进提交信息。

- [ ] **Step 2: 提取 loadout 类型与写入点**

在 `index.ts` 中新增（放在 `buildSubagentToolAllowlist` 附近，约 `:826` 之后）：

```ts
/**
 * Fully-resolved child loadout, snapshotted at spawn so resume can rebuild the
 * exact same restricted process instead of relaunching unrestricted.
 *
 * Single source of truth: spawn writes it, resume reads it. Neither side may
 * re-derive these values independently.
 */
interface SubagentLoadout {
  version: 1;
  agent?: string;
  toolAllowlist: string | null;
  denyTools: string[];
  model?: string;
  thinking?: string;
  systemPromptPath?: string;
  systemPromptFlag?: "--system-prompt" | "--append-system-prompt";
  cwd?: string;
  agentDir?: string;
  autoExit: boolean;
  interactive: boolean;
}

function loadoutPathFor(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}
```

约束：
- 字段值必须**取自 `launchSubagent` 里已经解析好的变量**（`effectiveTools` → `toolAllowlist`、`denySet`、`effectiveModel`、`effectiveThinking`、`effectiveCwd`、`effectiveAgentDir`、`effectiveInteractive`），不得重新解析 frontmatter —— 重新解析会引入第二个知识源。
- `systemPromptPath` 写已生成的 artifact 文件绝对路径（`index.ts:1560-1582` 那段已经在写这些文件），不要内联 prompt 正文。
- 写入时机：在 `launchSubagent` 里命令组装完成、`sendLongCommand` 之前，`mkdirSync(dirname(...), { recursive: true })` 后 `writeFileSync`。
- 写入失败**不得**阻断 spawn：包 try/catch，失败时 `console.error` 并继续（spawn 的可用性优先于 resume 的保真度）。

- [ ] **Step 3: 让 resume 消费快照**

在 `subagent_resume` 的 `execute`（`index.ts:2296`）里，`existsSync(params.sessionPath)` 检查之后、构造 `parts` 之前：

1. 读 `loadoutPathFor(params.sessionPath)`；不存在或 `version !== 1` 则视为**旧会话**。
2. 命中时把快照字段还原成与 spawn 同形的 CLI 参数与 env：`--tools`、`--model`、`thinking`、`--system-prompt` / `--append-system-prompt`、`PI_DENY_TOOLS`、`PI_CODING_AGENT_DIR`。
3. **未命中时明确拒绝，不静默降级为不受限重启**：

```ts
return {
  content: [{
    type: "text",
    text:
      `Refusing to resume: no loadout snapshot at ${loadoutPathFor(params.sessionPath)}.\n` +
      `This session predates sandboxed resume. Resuming it would relaunch the agent ` +
      `without its tool allowlist, model, or system prompt. Spawn a fresh subagent instead.`,
  }],
  details: { error: "loadout missing" },
};
```

- **不要**把 `autoExit` 从快照里读出来覆盖调用方参数。`resolveResumeLaunchBehavior`（`:1045`）的显式参数优先级更高，保持现状。
- 快照里的 `toolAllowlist` 已包含 `caller_ping` / `subagent_done`（spawn 时由 `buildSubagentToolAllowlist` 加过），resume 时**不要**二次追加。

- [ ] **Step 4: 加回归测试**

在 `extensions/subagents/test/test.ts` 新增：

```ts
describe("subagent loadout snapshot", () => {
  it("round-trips a restricted loadout", () => { /* 写入 → 读取 → 字段逐一相等 */ });
  it("refuses resume when the snapshot is missing", () => { /* 断言返回 details.error === "loadout missing" */ });
  it("refuses resume on an unknown snapshot version", () => { /* version: 99 */ });
});
```

若 `subagent_resume` 的 execute 当前不可直接被测试导入，先把「读快照 + 还原成 parts/env」抽成一个纯函数（例如 `buildResumeLaunchSpec(sessionPath, params)`）并 `export`，测这个纯函数。抽函数本身也是 SSOT 收敛的一部分。

- [ ] **Step 5: 验证**

```bash
cd extensions/subagents && npm test
rg -n 'loadout' pi-extension/subagents/index.ts | head -20
rg -n -- '--tools' pi-extension/subagents/index.ts | awk -F: '$1 > 2296'
git diff --check
```

预期：测试全过；resume 区段现在**有** `--tools` 命中；`git diff --check` 退出 0。

- [ ] **Step 6: 端到端手测（需要 tmux/herdr 会话）**

在一个真实 pi 会话里：

```
subagent({ agent: "scout", name: "loadout-check", task: "列出 extensions/ 下的目录名，然后结束" })
```

等它结束后 resume，并在子 pane 里让它尝试写文件。预期：因 scout 的 allowlist 无 `write`，工具不可见。若 `write` 可用则本 Task 未完成。

- [ ] **Step 7: 更新 README 并提交**

在 `extensions/subagents/README.md` 的 resume 相关段落加一段说明「resume 重放 spawn 时的 loadout 快照；早于本特性的会话会被明确拒绝」。

```bash
git add extensions/subagents/pi-extension/subagents/index.ts \
  extensions/subagents/test/test.ts \
  extensions/subagents/README.md
git commit -m "fix(subagents): replay spawn loadout on resume instead of relaunching unrestricted"
```

---

### Task 2: 新增 `ask_user_question` extension（主会话 → 人）

独立 extension，与 subagents 包解耦。

**Files:**
- Create: `extensions/ask-user-question/index.ts`
- Create: `extensions/ask-user-question/README.md`
- Create: `extensions/_common/ui-lock.ts`
- Modify: `package.json`（root）
- Modify: `docs/pi-agent-config-handbook.md`

**Interfaces:**
- Produces: 工具 `ask_user_question`（单问题、可选选项、可选 multiSelect、始终附带 "Other" 自由输入）。
- Consumes: `ctx.ui.custom` / `ctx.ui.editor`、`extensions/_common/ui-lock.ts`。

- [ ] **Step 1: 确认 TUI 包名解析（阻断性前置检查）**

源文件从 `@mariozechner/pi-tui` 导入 `Editor / Key / matchesKey / truncateToWidth / wrapTextWithAnsi`，但本仓库运行时装的是 `@earendil-works/pi-tui@0.79.10`。现有的 `extensions/web-fetch/index.ts:3` 用 `@mariozechner/pi-tui` 且工作正常。

```bash
rg -n 'pi-tui' extensions/web-fetch/index.ts extensions/web-search/index.ts extensions/index.ts
ls /home/lawrence/.pi/agent/npm/node_modules/@earendil-works/pi-tui/dist/index.d.ts
rg -n 'Editor|matchesKey|truncateToWidth|wrapTextWithAnsi' \
  /home/lawrence/.pi/agent/npm/node_modules/@earendil-works/pi-tui/dist/index.d.ts
```

已核实 `@earendil-works/pi-tui` 导出全部五个符号。**决策规则：** 与 `extensions/web-fetch/index.ts` 用同一个包名（当前是 `@mariozechner/pi-tui`）。若加载时报模块解析失败，改用 `@earendil-works/pi-tui` 并**同时**修 `web-fetch`，不要让两个 extension 用不同包名。

`ExtensionAPI` 类型固定从 `@earendil-works/pi-coding-agent` 导入（仓库现行约定）。

- [ ] **Step 2: 先把 UI 互斥锁做成真正的共享模块**

源文件用 `globalThis["__piSharedUiLock"]` 挂键跨文件共享锁 —— 这是 hack。本仓库有 `extensions/_common/`，用真模块：

```ts
// extensions/_common/ui-lock.ts
/**
 * ctx.ui.custom() / ctx.ui.editor() 同一时刻只能有一个活动调用。
 * 所有弹窗型工具必须互相串行，而不只是和自己串行。
 */
let chain: Promise<void> = Promise.resolve();

export function withUILock<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = chain;
  let release!: () => void;
  chain = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(() => release());
}
```

约束：`prev.then(fn)` 里 `fn` 抛错时后续调用仍须能拿到锁 —— `finally` 保证了这点，但要有测试覆盖。

- [ ] **Step 3: 移植工具本体**

从 `/home/lawrence/repo/repo-llm/pi-config/extensions/ask-user-question.ts` 移植，逐条应用以下修改：

1. **`Type` 从 `typebox` 导入**，不是 `@sinclair/typebox`（root `package.json` 的依赖是 `typebox`）。
2. **把 `withUILock` 换成 `import { withUILock } from "../_common/ui-lock.ts";`**，删掉 `SHARED_UI_LOCK_KEY` / `getSharedUiLock` 整段。注意 `.ts` 后缀。
3. **可用性守卫从 `ctx.hasUI` 改成 `ctx.mode === "tui"`。** 依据：`hasUI` 在 TUI 和 RPC 模式都为 true，而 `ui.custom` 是 terminal-only（`types.d.ts:211-214`）。原样照抄会在 RPC 模式下崩。`unavailableResult` 的文案相应改为 `ask_user_question requires the terminal (TUI) UI`。
4. **保留 render 缓存按 width 做 key 的逻辑和那两段注释一字不改** —— pi-tui resize 时只调 `requestRender()` 不调 `invalidate()`，返回旧的宽行会撞宽度守卫直接崩进程。这是原作者踩过的坑。
5. 保留 `signal?.aborted` 早退、`renderCall` / `renderResult`、三种 answer 类型（text / option / other）和排序逻辑。

- [ ] **Step 4: 按仓库约定决定入口结构**

`ask_user_question` 是纯 TUI 工具，**没有 CLI 对应物**（CLI 里无法向人提问），属于 AGENTS.md 里 "unless intentionally agent-only" 的合理例外。

因此：
- **不**建 `dev.ts` / `chain.ts` / `core.ts` 双入口结构。
- **不**在 `package.json` 里声明 `pi.cli`，**不**改 `extensions/install.sh`（该脚本只处理 CLI 二进制）。
- **不**注册 `pi.registerCommand` —— 人主动敲命令问自己没有意义。
- 在 `extensions/ask-user-question/README.md` 里用一段话记下这个例外的理由，避免以后有人「补齐」它。

- [ ] **Step 5: 注册 extension**

root `package.json`：

```json
"pi": {
  "extensions": ["./extensions/index.ts", "./extensions/web-search", "./extensions/web-fetch", "./extensions/subagents", "./extensions/ask-user-question"],
```

- [ ] **Step 6: 验证**

```bash
node --experimental-strip-types --no-warnings -e "import('./extensions/ask-user-question/index.ts').then(m => console.log(typeof m.default))"
node --test extensions/_common/*.test.ts
rg -n 'hasUI' extensions/ask-user-question/index.ts
rg -n '__piSharedUiLock' extensions/ask-user-question/index.ts
```

预期：打印 `function`；ui-lock 测试通过（含「fn 抛错后锁仍可获取」一例）；`hasUI` **无命中**（已换成 `mode`）；`__piSharedUiLock` **无命中**。

- [ ] **Step 7: 交互手测**

真实 pi 会话里逐个试三种模式，**每种都要拉宽再拉窄终端窗口**验证不崩：

| 模式 | 触发 | 验证点 |
| --- | --- | --- |
| text | 无 `options` | 打开多行编辑器；Esc 取消返回 cancelled |
| single-select | 有 `options` | ↑↓ 移动、Enter 选中、选 Other 后可输入 |
| multi-select | `multiSelect: true` | Space 勾选、未选时 Submit 被拒并提示、Enter 提交 |

- [ ] **Step 8: 更新手册并提交**

在 `docs/pi-agent-config-handbook.md` 的架构图与 extension 列表里加入 `ask-user-question`，注明它是 agent-only（无 CLI）。

```bash
git add extensions/ask-user-question/ extensions/_common/ui-lock.ts \
  package.json docs/pi-agent-config-handbook.md
git commit -m "feat(ask-user-question): TUI clarifying-question tool with shared UI lock"
```

---

### Task 3: name registry + `subagent_message`（按名寻址，合并 steer 与 resume）

现状 `subagent_resume` 要求模型自己搬运 `.jsonl` 绝对路径 —— 让 LLM 搬运不透明字符串是错误源。

**取舍（与 amos 不同）：** amos 把 `subagent_interrupt` 也并掉了。本仓库**保留** `subagent_interrupt`：它语义是「打断当前 turn」，和「发消息」不同，且 `handleSubagentInterrupt`（`index.ts:948`）已在工作。只新增 `subagent_message`，并把 `subagent_resume` 标记为 deprecated 但**不删**（AGENTS.md：delete only when it blocks requirements）。

**Files:**
- Modify: `extensions/subagents/pi-extension/subagents/index.ts`
- Modify: `extensions/subagents/test/test.ts`
- Modify: `extensions/subagents/README.md`

**Interfaces:**
- Produces: `artifacts/<sessionId>/subagent-registry.json`，name → `{ sessionFile, agent, spawnedAt, loadoutPath }`。
- Produces: 工具 `subagent_message({ name, message })`。
- Consumes: Task 1 的 `<session>.loadout.json`。

- [ ] **Step 1: RED baseline**

```bash
cd extensions/subagents
rg -n 'subagent-registry|subagent_message' pi-extension/subagents/index.ts
rg -n 'sessionPath' pi-extension/subagents/index.ts | head
```

预期：前者无输出；后者显示 `subagent_resume` 仍以 `sessionPath` 为必填入参。

- [ ] **Step 2: 实现 registry**

- 路径：`join(getArtifactDir(sessionDir, sessionId), "subagent-registry.json")`（复用 `index.ts:550` 的 `getArtifactDir`，不要新造路径函数）。
- 写入时机：`launchSubagent` 成功组装并发出启动命令后。
- **名字唯一性**：重名自动加后缀（`scout`、`scout-2`、…）。唯一化后的名字必须同时用于 pane 标题、widget 显示和 registry key —— 三处是同一条知识，只能算一次。
- 嵌套子 agent 用**自己的 sessionId** 建自己的 registry（父的 registry 不记录孙代）。
- 读写都要容错：文件损坏时当作空 registry 并 warn，不抛。

- [ ] **Step 3: 实现 `subagent_message`**

参数只有 `name: string` 和 `message: string`。行为分叉：

| 目标状态 | 行为 |
| --- | --- |
| running | 把消息打进活动 pane（换行压平成单行），下一个 turn 边界被拾取。**立即返回**；最终完成结果仍走既有 steer 路径 |
| finished | 从 registry 取 `sessionFile` + `loadoutPath`，走 Task 1 的受限 resume 路径，以该消息作为后续任务。fire-and-forget，结果稍后 steer 回来。resumed run 复用原名字 |
| 未注册 / session 文件已删 / 无 loadout 快照 | 明确报错，**并在错误信息里列出已知名字** |

工具描述里必须显式写「异步；结果自动送达；绝不轮询」，与现有 `subagent` / `subagent_resume` 的措辞保持一致。

- [ ] **Step 4: 测试**

```ts
describe("subagent registry", () => {
  it("assigns unique names with numeric suffixes", () => { /* scout, scout-2, scout-3 */ });
  it("survives a corrupt registry file", () => { /* 写入 "not json" → 读到空 registry，不抛 */ });
  it("lists known names in the not-found error", () => { /* 断言错误文案含已注册名字 */ });
});
```

- [ ] **Step 5: 验证**

```bash
cd extensions/subagents && npm test
rg -n 'subagent-registry.json' pi-extension/subagents/index.ts
rg -n 'getArtifactDir' pi-extension/subagents/index.ts   # 确认没有第二个路径函数
git diff --check
```

- [ ] **Step 6: 手测**

spawn 两个同名 scout → 确认 widget 显示 `scout` 与 `scout-2`；对 running 的发消息 → 确认 pane 收到；等其结束后再对同名发消息 → 确认走受限 resume 且工具集仍受限。

- [ ] **Step 7: README 与提交**

README 工具表加入 `subagent_message`；`subagent_resume` 标注 deprecated 并指向前者。

```bash
git add extensions/subagents/pi-extension/subagents/index.ts \
  extensions/subagents/test/test.ts extensions/subagents/README.md
git commit -m "feat(subagents): name registry and subagent_message addressing"
```

---

### Task 4: `ask_question`（子 agent → 父 agent 反问）

补上最后一条通道。子 agent 现在遇到歧义只能猜或退出。

**分层规则（不可违背）：** 子 agent **不得**调用 `ask_user_question`。它的 `ctx.ui` 是自己 pane 的 TUI，不是人的注意力焦点，弹窗会永远没人看。子会话只能 `ask_question` → steer 给父 → 父再决定自己答还是升级给人（这时父才用 `ask_user_question`）。

**Files:**
- Modify: `extensions/subagents/pi-extension/subagents/subagent-done.ts`
- Modify: `extensions/subagents/pi-extension/subagents/index.ts`
- Modify: `extensions/subagents/test/test.ts`
- Modify: `extensions/subagents/README.md`
- Modify: `extensions/subagents/agents/*.md`（相关 agent 的 prompt）

**Interfaces:**
- Produces: 子会话专属工具 `ask_question({ question })`。
- Consumes: Task 3 的 `subagent_message` 作为回复通道。

- [ ] **Step 1: RED baseline**

```bash
cd extensions/subagents
rg -n 'ask_question' pi-extension/subagents/subagent-done.ts pi-extension/subagents/index.ts
rg -n 'caller_ping' pi-extension/subagents/subagent-done.ts | head
```

预期：`ask_question` 无输出；`caller_ping` 有 —— 已有的 ping 机制是 `ask_question` 的参照实现，复用它的 steer 路径，不要新造。

- [ ] **Step 2: 在 subagent-done.ts 注册 `ask_question`**

- 只在子会话注册（沿用 `caller_ping` 现有的 `PI_SUBAGENT_*` env 判定条件，不新增判定方式）。
- 参数：单个 `question: string` 自由文本（不做选项 —— 父是 LLM，不需要 UI 选择器）。
- 行为：向父 steer 一条带**子 agent 名字**的通知，然后把会话**停在 `waiting`**，等待下一轮输入。
- 支持并行提问：每个 waiting 的子 agent 靠自己的名字区分。

- [ ] **Step 3: 让 auto-exit 在有未答问题时挂起**

`buildSubagentToolAllowlist`（`index.ts:826`）目前对 auto-exit agent 只放行 `caller_ping`。改为**同时放行 `ask_question`**。

关键约束：`auto-exit: true` 的 agent 在有未答 `ask_question` 时**不得退出**，必须 park 成 `waiting`。检查现有 auto-exit 触发点，加一个「未答问题计数 > 0」的抑制条件。

- 回复在子 agent 仍在 turn 中到达 → 被吸收进当前 turn，问题标记已答，工作做完后正常退出。
- 父永远不回 → pane 保持打开，等人来关。**不要**加超时自动退出（静默丢弃问题比挂起更糟）。

- [ ] **Step 4: 更新 agent prompts**

在 `extensions/subagents/agents/` 下相关 agent 的正文里加入使用边界：

```markdown
需求有歧义、或某个决定会实质改变产出时，用 `ask_question` 向调用方提一个问题，然后等待答复。
不要猜，也不要因为不确定就提前结束。
不要向人提问 —— 你在自己的 pane 里，没人在看。
```

**不要**加到 `visual-tester.md`（它的适配是独立决策，见 Global Constraints）。

- [ ] **Step 5: 验证**

```bash
cd extensions/subagents && npm test
rg -n 'ask_question' pi-extension/subagents/subagent-done.ts pi-extension/subagents/index.ts
rg -n 'ask_user_question' agents/*.md          # 必须无命中：子 agent 不得用它
rg -n 'ask_question' agents/visual-tester.md   # 必须无命中
git diff --check
```

- [ ] **Step 6: 手测（本 Task 的核心验收）**

spawn 一个任务故意留歧义的 worker（例如「把配置里的超时改一下」，不说改成多少）：

1. 子 agent 调 `ask_question`，pane 停在 `waiting` 而**不是**退出。
2. 父会话被 steer 唤醒，收到带名字的问题。
3. 父用 `subagent_message({ name, message })` 回复。
4. 子 agent 用答复继续，完成后正常退出，结果 steer 回父。

四步全过才算完成。若 auto-exit 的 worker 在第 1 步就退出，说明 Step 3 的抑制条件没生效。

- [ ] **Step 7: README 与提交**

README 工具表加入 `ask_question`（标注「仅子会话」），并写清上面的分层规则。

```bash
git add extensions/subagents/pi-extension/subagents/subagent-done.ts \
  extensions/subagents/pi-extension/subagents/index.ts \
  extensions/subagents/test/test.ts \
  extensions/subagents/README.md extensions/subagents/agents/
git commit -m "feat(subagents): ask_question channel from child to orchestrator"
```

---

### Task 5: `subagent_agents` spawn 白名单（逐层强制）

现状：有 `--tools` allowlist，但**没有逐层 spawn 白名单**。嵌套子 agent 可以 spawn 一个不受限 profile 完成提权。

**Files:**
- Modify: `extensions/subagents/pi-extension/subagents/index.ts`
- Modify: `extensions/subagents/test/test.ts`
- Modify: `extensions/subagents/agents/worker.md`
- Modify: `extensions/subagents/README.md`

- [ ] **Step 1: RED baseline**

```bash
cd extensions/subagents
rg -n 'PI_SUBAGENT_ALLOWED|subagent_agents' pi-extension/subagents/index.ts agents/*.md
```

预期：无输出。

- [ ] **Step 2: 解析 frontmatter 字段**

在 `parseAgentDefinition`（`index.ts:254`）里解析 `subagent_agents`（逗号分隔）。沿用已有的 `getFrontmatterValue` 辅助函数。

**双重语义（这是 amos 的设计精髓，照抄）：**
- 字段**存在** → 授予 spawn 工具集（`subagent`、`subagent_message`、`subagents_list`）**并且**把 spawn 目标限制在列表内。
- 字段**缺失** → 该 agent 完全不能 spawn。

这样省掉一个单独的开关，且默认是安全的（不写就不能 spawn）。

- [ ] **Step 3: 逐层强制**

- spawn 时把已解析的列表写进 `PI_SUBAGENT_ALLOWED` env（与 `PI_DENY_TOOLS` 同一处 env 组装，`index.ts:1595` 附近）。
- `subagent` 工具的 `execute` 开头检查：若 `PI_SUBAGENT_ALLOWED` 已设置，则请求的 `agent` 必须在其中，否则拒绝并列出允许的名字。
- 顶层会话（env 未设置）可 spawn 任何可发现的 agent —— 保持现状。
- 把 `subagent_agents` 一并存进 Task 1 的 loadout 快照，让 resume 也重放这条限制。

- [ ] **Step 4: 给 worker 开口子**

`extensions/subagents/agents/worker.md` 加 frontmatter：

```yaml
subagent_agents: scout, researcher
```

**不要**给 scout / researcher 加这个字段（它们是叶子，不应能 spawn）。

- [ ] **Step 5: 测试**

```ts
describe("spawn whitelist", () => {
  it("parses subagent_agents from frontmatter", () => {});
  it("grants the spawning toolset only when the field is present", () => {});
  it("rejects a spawn target outside PI_SUBAGENT_ALLOWED, listing allowed names", () => {});
  it("allows any discoverable agent at top level", () => { /* env 未设置 */ });
});
```

- [ ] **Step 6: 验证与提交**

```bash
cd extensions/subagents && npm test
rg -n 'PI_SUBAGENT_ALLOWED' pi-extension/subagents/index.ts
rg -n 'subagent_agents' agents/worker.md
rg -n 'subagent_agents' agents/scout.md agents/researcher.md   # 必须无命中
git diff --check
```

```bash
git add extensions/subagents/pi-extension/subagents/index.ts \
  extensions/subagents/test/test.ts \
  extensions/subagents/agents/worker.md extensions/subagents/README.md
git commit -m "feat(subagents): depth-wise spawn whitelist via subagent_agents"
```

---

## Final Verification

五个 Task 全部完成后，从仓库根目录：

```bash
npm run test:subagents
node --test extensions/_common/*.test.ts
npm --prefix extensions/subagents run test:integration
git diff --check
git status --short
```

然后逐条对照 Global Constraints 做整体复核：

- [ ] 多路复用器支持未收窄 —— `rg -n 'herdr|cmux|zellij|wezterm' extensions/subagents/pi-extension/subagents/cmux.ts | wc -l` 与改动前一致
- [ ] 模型池未被改动 —— `git diff HEAD~5 -- extensions/subagents/pi-extension/subagents/index.ts | rg -n 'resolveEffectiveModelWithPool|markModelFailed'` 无删除行
- [ ] `/plan`、`/iterate`、`subagent_interrupt` 仍注册
- [ ] 无新增运行时依赖 —— `git diff HEAD~5 -- package.json extensions/subagents/package.json` 只改 `pi.extensions` 数组
- [ ] 三条提问通道各就各位且未串层：主会话→人 = `ask_user_question`；子→父 = `ask_question`；双向寻址 = `subagent_message`
- [ ] `rg -n 'ask_user_question' extensions/subagents/` 无命中（子 agent 侧绝不引用它）

## 明确不做

| 项 | 理由 |
| --- | --- |
| 收窄为 tmux-only | 已支持 herdr/cmux/zellij/wezterm 且在用 |
| 抄 amos 的 bundled agents（硬编码 `glm-5.3`） | 本仓库的模型池 + 429 回退更强 |
| 删除 `/plan`、`/iterate` | amos 砍了；本仓库保留 |
| 删除 `subagent_interrupt` | 语义与 `subagent_message` 不同，且已在工作 |
| `registerToolExtension` 运行时注册钩子 | 当前无实际需求，等有需求再说 |
