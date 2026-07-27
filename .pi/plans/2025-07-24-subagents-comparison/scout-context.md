# Subagents 扩展对比报告

> 对比两个 subagents 扩展目录：`my-pi-setup`（自研）vs `pi-agent-config`（vendored pi-interactive-subagents v3.7.2）

---

## 1. 基本档案

| 维度 | my-pi-setup | pi-agent-config |
|------|-------------|-----------------|
| 代码量 | ~2068 行 (14 个 .ts 文件) | ~9393 行 (15 个 .ts 文件 + agents + 测试) |
| 核心依赖 | `effect` v4, `@anthropic-ai/claude-agent-sdk` | `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox` |
| 后端模式 | in-process SDK (pi) + Claude Agent SDK + Codex JSON-RPC | mux pane (cmux/tmux/zellij/wezterm/herdr) 启动独立 pi/claude 进程 |
| 架构风格 | Effect v4 纯函数式 (Layer, ManagedRuntime, Stream, Scope) | 传统命令式 + 全局状态，通过 `__test__` exports 测试 |
| 订阅源 | 上游自研，小团队迭代 | vendored 自 https://github.com/HazAT/pi-interactive-subagents v3.7.2 |
| 测试模式 | manager smoke (stub backend) + 6 个独立 test 文件 | 单文件大型测试 (~2700 行) session/status/cmux/activity/discovery/agent-done |

## 2. 关键文件映射

| 功能层 | my-pi-setup | pi-agent-config |
|--------|------------|-----------------|
| 入口 + 工具注册 | `index.ts` (23K) | `pi-extension/subagents/index.ts` (25K) |
| 后端接口抽象 | `src/backend.ts` | 无 — 直接 CLI 调用 |
| Domain 模型 | `src/domain.ts` (全部类型化 Event/Snapshot) | 内联在 `index.ts` 中 |
| 状态管理 | `src/manager.ts` (Effect + Fiber) | `index.ts` 全局 `runningSubagents` Map |
| Mux 操作 | 无 | `cmux.ts` (1.4K, 5 种 mux 后端) |
| 状态机 | 无 | `status.ts` (stalled/active/waiting 转换) |
| Activity 跟踪 | 无 | `activity.ts` (文件轮询) |
| 子代理内扩展 | 无 | `subagent-done.ts`, `plan-skill.md` |
| Session 操作 | 无 | `session.ts` (seed/merge/find 等) |
| Agent 定义 | 无 | `agents/scout|planner|worker|researcher|reviewer|visual-tester|claude-code.md` |
| 插件 | 无 | `plugin/.claude-plugin/` + `plugin/hooks/` |

## 3. 架构对比

### my-pi-setup — 纯 Effect v4 管道

```
用户工具调用 → ManagedRuntime → SubagentManager
  ├─ pi backend (in-process SDK AgentSession)
  ├─ claude backend (@anthropic-ai/claude-agent-sdk streaming)
  └─ codex backend (子进程 JSON-RPC)

标准化 SubagentEvent Stream → fold 为 SubagentSnapshot
```

- 每个子代理是一个 `Scope` 内的 `SubagentSession`，关闭 scope 即杀子进程
- 事件流用 `Stream.Stream<SubagentEvent>` 表达，Manager 用 `Stream.runFold` 维护快照
- 后端接口通过 `BackendRegistry` `Context.Service` 注入
- **优势**: 类型安全、资源安全(Scope)、并发模型清晰(Fiber)
- **劣势**: `effect` v4 beta 依赖、学习曲线陡、in-process SDK 耦合严重

### pi-agent-config — mux pane + 子进程

```
用户工具调用 → index.ts (全局 runningSubagents Map)
  ├─ launchSubagent(): 创建 mux pane → 发送 CLI 命令
  ├─ watchSubagent(): 轮询退出 + 读取 session 文件
  └─ 轮询活动文件 → StatusMachine 状态机 → Widget + steer message
```

- 子代理是独立的 `pi` 或 `claude` 进程，在独立的 mux pane 中运行
- 通信通过文件系统: session JSONL、activity 文件、sentinel 文件
- 状态机 (`status.ts`) 轮询 activity 文件判断 stalled/active/waiting
- **优势**: 完全解耦、可观察(activity 文件)、支持所有 mux、agent 定义系统丰富(frontmatter)
- **劣势**: 文件系统轮询、全局可变状态、/reload 需要靠 Symbol hack 清理定时器

## 4. 功能对比

| 功能 | my-pi-setup | pi-agent-config |
|------|-------------|-----------------|
| 子代理后端 | pi (in-process), Claude Code SDK, Codex | pi (子进程 CLI), Claude Code (子进程 CLI) |
| "by the way" 侧线 | ✅ 完整支持 (btw command + inline entry) | ❌ 无 |
| subagent_wait 阻塞等待 | ✅ Effect 原生 | ❌ 无 (靠 steer 消息异步通知) |
| 子代理 Interrupt | ✅ Effect Fiber.interrupt | ✅ Escape 键发送到 mux pane |
| Live 状态 Widget | ✅ 扩展状态栏 (running/done/failed) | ✅ Widget (starting/active/waiting/stalled) |
| 轮询/事件驱动 | 事件驱动 (SDK 事件回调) | 文件轮询 (activity 文件 + status 状态机) |
| Session mode | ❌ 无 | ✅ standalone/lineage-only/fork |
| Agent frontmatter 系统 | ❌ 无 | ✅ 完整: model/tools/skills/thinking/contextFiles/systemPromptMode |
| /plan, /iterate 命令 | ❌ 无 | ✅ 内置 |
| 项目 context 传播 | ❌ 继承 parent cwd trust | ✅ collectProjectContextFiles + context-files: project |
| 模型 override 验证 | ✅ 通过 modelRegistry | ✅ provider/model + bare claude alias |
| 子代理工具限制 | ❌ 无 | ✅ deny-tools frontmatter + spawning 门控 |
| 多 mux 支持 | ❌ 无 (in-process 不需要) | ✅ cmux/tmux/zellij/wezterm/herdr |
| 结果输出截断 | ✅ 24KB/600 lines | ✅ 但有截断策略 |

## 5. 各自优缺点

### my-pi-setup 优点

1. **事件驱动，效率高** — 后端事件实时推送，无需轮询。资源消耗低 (in-process SDK)。
2. **类型安全** — Effect v4 全链路类型化 (35+ 事件类型），编译期捕获错误。
3. **并发模型严谨** — Fiber 隔离 + Scope 管理生命周期，不会泄漏子进程。
4. **代码量少 (~2K 行)** — 功能集中，便于快速理解和修改。
5. **"by the way" 侧线功能** — 不干扰主会话的侧线问题查询。

**证据**: `src/manager.ts:81-130` — pump fiber fold events into snapshot; `src/domain.ts` 定义了完整的 `SubagentEvent` 联合类型。

### my-pi-setup 缺点

1. **后端耦合严重** — pi backend 直接 import pi SDK 的 `createAgentSession()` (`src/backends/pi.ts`)，pi 版本升级时可能 break。
2. **无 agent 定义系统** — 所有工具调用需要显式传 `harness`、`model`；没有 frontmatter 的 agent 模板概念。每个子代理都是裸 spawn。
3. **依赖 `effect` v4 beta** — API 不稳定的风险，团队需要 Effect 知识。
4. **无 context 传播机制** — 子代理拿不到项目的 CLAUDE.md/AGENTS.md 上下文。
5. **无 session mode** — 每次 spawn 都是独立 session，无法 lineage 或 fork。
6. **Claude Code SDK + Codex 后端实为 stub** — `src/backends/stub.ts` 用于测试，真实后端尚未完全实现。design doc 承认 "stubbed backends"。

**证据**: `src/backends/` 下三个目录，但测试用 `stub.ts` 替换真实后端；`docs/design-plan.md` 明确写 "stubbed backends initially"。

### pi-agent-config 优点

1. **完全解耦** — 子代理是独立 OS 进程，各自的 pi 版本、配置、`node_modules` 互不影响。
2. **Agent 定义系统成熟** — 7 个内置 agent (scout/planner/worker/researcher/reviewer/visual-tester/claude-code)，每个有完整 frontmatter 配置: model/tools/skills/thinking/contextFiles/systemPromptMode/sessionMode/spawning/autoExit/interactive。
3. **Context 传播智能** — `context-files: all|project|none` 控制子代理看到的项目指令文件范围。`project` 模式从 git root 到 cwd 逐级收集 AGENTS.md/CLAUDE.md。
4. **Session mode 灵活** — `standalone` 干净启动，`lineage-only` 保留父会话引用但不拷贝上下文，`fork` 完全继承父会话对话历史。
5. **多 mux 支持** — cmux/tmux/zellij/wezterm/herdr，无需改造。
6. **测试全面** — 完整 session 操作（getNewEntries/findLastAssistantMessage/seedSubagentSessionFile/mergeNewEntries）、状态机状态图测试（stalled/recovered/interrupt/active/waiting/transient-missing）、agent 发现测试（shadowing/disable/hidden/priority）、cmux 解析测试。
7. **子代理内扩展 (`subagent-done.ts`)** — auto-exit 自动关闭、interactive 提供 `subagent_done` 工具、活动记录到 activity 文件。

**证据**: `index.ts:resolveEffectiveSessionMode` + `seedSubagentSessionFile` + `collectProjectContextFiles`; `test/test.ts` 的 2700+ 行全覆盖测试。

### pi-agent-config 缺点

1. **文件轮询性能** — 1s 间隔读 activity 文件、1s widget 刷新、pollForExit 1s。大量小 IO，在大量子代理时明显。
2. **全局状态板** — `runningSubagents` Map、`latestCtx`、`widgetInterval`、`statusInterval` 全部全局。`/reload` 要靠 Symbol hack (POLL_ABORT_KEY/WIDGET_INTERVAL_KEY) 清理，脆弱。
3. **子代理启动延迟** — 每次启动完整 `pi` CLI 进程（加载所有扩展、解析配置），~500ms 启动延迟（加上默认 500ms $SHELL_READY_DELAY_MS）。不适用于大量快速子代理场景。
4. **文件系统协议脆弱** — activity 文件 JSON 解析错误、sentinel 文件不存在、session 文件被并发写入。`test/test.ts` 中大量测试专门覆盖这些边缘情况，说明作者知道这些脆弱点。
5. **代码量庞大 (~9.4K 行)** — 包含 1.4K 行 cmux.ts（5 种 mux 后端各自的 pane/create/send/read/poll 实现）、1.4K 行 status.ts（跨 60s 阈值的状态图）、2.7K 行测试。
6. **无 wait 原语** — 不支持 `subagent_wait` 阻塞等待。Agent 只能通过 steer 消息被动接收结果。

## 6. 适合场景

| 场景 | 推荐 |
|------|------|
| 快速并行探索 (启动 4-8 个同时 scout) | my-pi-setup (in-process, 轻量) |
| 长时间运行的子代理 (分析、重构) | pi-agent-config (进程隔离, 不易泄漏) |
| 子代理需要不同的 pi 版本 | pi-agent-config (独立 CLI) |
| 严格类型安全要求 | my-pi-setup (Effect v4) |
| 丰富的 Agent 模板系统 | pi-agent-config (frontmatter) |
| 子代理需要完整项目上下文 | pi-agent-config (context-files + fork) |
| 与 Claude Code 混合使用 | pi-agent-config (CLI 直接驱动) |
| 极简代码量，快速迭代 | my-pi-setup |
| 生产可靠性 | pi-agent-config (充分测试 + 进程隔离) |

## 7. 迁移/合并建议

### 核心建议: 以 pi-agent-config 为基底，吸收 my-pi-setup 的 in-process 后端

**理由**: pi-agent-config 已成熟 (v3.7.2, 7+ agent, 完整测试, 社区使用)。my-pi-setup 的核心优势是轻量 in-process 后端，可以「plugin」式接入。

#### Phase 1 — 将 my-pi-setup 的 in-process 后端作为可选并行路径

在 pi-agent-config 的 `launchSubagent()` 中增加后端选择:

```
backend: "mux" (默认)    → 当前 mux pane + 子进程 CLI (稳定、隔离)
backend: "inline"        → in-process SDK (快速、轻量)
```

具体改动:

1. 在 agent frontmatter 增加 `backend: inline|mux` 字段
2. 创建 `src/backends/inline.ts` — 提炼 my-pi-setup 的 `SubagentBackend` 接口 + pi backend 实现，去掉 effect 依赖（改为简单 async/await）
3. `launchSubagent()` 中 `backend === "inline"` 时不创建 mux pane，直接调用 inline backend
4. 结果提取逻辑复用: inline backend 完成后一样写入 session 文件、写入 done sentinel

这样:
- **快速探索**用 `inline` 后端 (my-pi-setup 风格)
- **隔离任务**用 `mux` 后端 (当前 pi-agent-config 风格)
- **同一个 agent frontmatter 系统** — `backend` 字段在 frontmatter 中声明
- `MAX_RUNNING` 上限按后端独立计

#### Phase 2 — 吸收 "by the way" 功能

my-pi-setup 的 `/btw` 命令 + inline entry 渲染是独立功能模块。可直接移植到 pi-agent-config:

1. 注册 `/btw` 命令，`index.ts` 中约 30 行
2. 注册 `btw-result` entry renderer
3. 用 `inline` 后端启动 (避免 mux pane 开销)

#### Phase 3 — 放弃的 vs 保留的

| 保留（来自 pi-agent-config） | 放弃 |
|------|------|
| Agent frontmatter 系统 | my-pi-setup 的无 agent 模型 |
| context-files + session mode | my-pi-setup 的裸 spawn |
| mux pane 后端 | my-pi-setup 的 Claude Code SDK（已被 `cli: claude` 替代） |
| status 状态机 + widget | my-pi-setup 的简单状态栏 |
| cmux.ts 多 mux 支持 | — |
| 子代理内扩展 (subagent-done.ts) | — |

| 吸收（来自 my-pi-setup） | 理由 |
|------|------|
| `SubagentBackend` 接口抽象 | 统一多后端的基础 |
| inline/in-process backend | 快速并行启动场景 |
| "by the way" 命令 | 常用交互模式 |

## 8. 具体文件引用

### my-pi-setup 关键文件

- `index.ts` — 入口 + 5 个工具 + 2 个命令 + 2 个 renderer，与 pi 框架耦合最紧密
- `src/backend.ts` — 统一后端接口 `SubagentBackend` + `SubagentSession`，最值得迁移的部分
- `src/domain.ts` — 完整事件模型，35+ 类型，Effect Data.TaggedError 风格
- `src/manager.ts` — FSM + Fiber pump，~700 行，核心状态管理
- `src/backends/stub.ts` — 测试用伪造后端
- `src/by-the-way.ts` — 侧线功能
- `src/prompt.ts` — 所有 tool 描述/参数/guidelines 集中管理

### pi-agent-config 关键文件

- `pi-extension/subagents/index.ts` — 全部逻辑内联，~2.4K 行
- `pi-extension/subagents/cmux.ts` — 5 种 mux 后端操作，1.4K 行
- `pi-extension/subagents/status.ts` — 状态机，1.4K 行
- `pi-extension/subagents/session.ts` — session 文件操作
- `pi-extension/subagents/activity.ts` — activity 文件读写
- `pi-extension/subagents/subagent-done.ts` — 子代理内扩展
- `agents/*.md` — 7 个 agent 定义
- `test/test.ts` — 2700+ 行全面测试

## 9. 风险提示

1. **pi-agent-config 是 vendored 包** — 直接修改后无法 `pi install` 升级。需要 fork 或 patch 策略。
2. **my-pi-setup 的 effect 依赖不能简单去掉** — Effect 类型 (`Effect`, `Stream`, `Scope`) 贯穿整个 backend 接口。提取 inline backend 需要改为普通 async 函数签名。
3. **并发上限管理** — in-process backend 应该使用独立的并发池（比如 p-limit），避免阻塞主 session 的 Event Loop。
4. **会话文件兼容** — 两种后端输出的 session 文件格式应该一致，保证 `/resume` 可以无缝恢复。
