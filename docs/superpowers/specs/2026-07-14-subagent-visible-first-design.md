# Subagent 默认可见优先设计

**日期：** 2026-07-14

## 目标

让 extension 自身保证普通委派默认优先使用 Herdr/tmux 可见窗格，而不是依赖主代理记住选择 `subagent_visible`。如果可见执行在启动阶段不可用或失败，则自动回退到现有同步 `subagent` 执行，并明确报告回退原因。

## 当前问题

当前两个入口完全分离：

- `subagent` 始终同步执行并等待结果；
- `subagent_visible` 异步创建可见窗格并稍后投递结果；
- 工具提示还明确要求普通委派优先 `subagent`。

因此，即使用户长期偏好可见执行，主代理只要选择了 `subagent`，extension 就没有机会纠正。

## 统一入口设计

### `subagent`

`subagent` 成为默认 visible-first 入口：

1. 解析并校验 agent、自启动限制和工作目录；
2. 当 `visible` 未显式设为 `false` 且 `ctx.mode === "tui"` 时，尝试现有可见生命周期；
3. 可见启动成功后立即返回 started 确认，最终结果继续由现有 watcher 异步投递；
4. 不满足可见条件或启动阶段抛错时，调用现有 `runSubagent()` 同步完成任务；
5. 同步回退结果包含 `dispatchMode: "sync-fallback"` 和可读的 `fallbackReason`；
6. 显式传入 `visible: false` 时直接同步执行，不先尝试可见窗格。

`visible` 是直接传给统一调度逻辑的语义布尔值，默认 `true`，不再引入 mode 枚举或额外转换层。

### `subagent_visible`

保留该工具以兼容现有调用，但内部复用同一 visible-first 调度逻辑。它默认请求可见执行；如果启动阶段失败，同样自动同步回退并报告原因。工具提示将其描述为兼容/显式可见优先入口，不再鼓励模型在普通委派时二选一。

### 命令入口

`/subagent` 继续生成对 `subagent` 的调用，自动继承 visible-first 行为。`/subagent-visible` 保留兼容性，并使用相同启动失败回退语义。

## 回退边界

以下情况触发同步回退：

- `ctx.mode` 不是 `"tui"`（print、JSON、RPC）；
- `detectVisibleTarget()` 找不到 Herdr/tmux 目标；
- 创建 pane、写入启动文件或启动子 Pi 进程时抛错；
- 调用方显式传入 `visible: false`。

只有**启动阶段**允许回退。可见子代理已经成功启动后，它自己的任务失败、模型失败或用户中断不会再次同步执行，避免同一任务产生两份副作用。

回退是自动的，但不是静默的：工具文本和 details 都应说明回退原因。

## 资源清理

`launchVisibleSubagent()` 在启动完成前失败时必须清理它已经创建的临时目录；如果 pane 已创建，也应尽力关闭。清理失败不得覆盖原始启动错误，也不得阻止同步回退。

成功启动后的 pane、session、auto-exit、interrupt、resume 和 watcher 生命周期保持不变。

## 返回与渲染

统一调度返回两类结果：

- `dispatchMode: "visible"`：包含 run id、pane backend/id、interactive 状态，工具立即返回；
- `dispatchMode: "sync" | "sync-fallback"`：包含现有 `AgentResult`；回退时额外包含 `fallbackReason`。

`subagent.renderResult()` 同时支持 visible started 和同步结果。同步回退在 TUI 中显示简短的 fallback 标识，展开后可查看原因。

## 提示词

更新 `subagent` 的 description 和 prompt guidelines：

- 普通委派只调用 `subagent`；
- TUI + live mux 时它会自动可见执行；
- visible started 后等待异步完成消息，不得编造结果；
- extension 会自动处理同步回退。

移除“普通委派优先同步 `subagent`、只有需要时才用 visible”的旧指导。

## 测试

增加针对统一调度和资源清理的测试：

1. TUI + live mux：选择 visible，不调用同步执行；
2. 非 TUI：同步回退并记录原因；
3. 无 live mux：同步回退并记录原因；
4. visible 启动抛错：同步回退且只执行一次任务；
5. visible 已成功启动后的失败消息：不触发同步重跑；
6. `visible: false`：直接同步执行；
7. 启动失败：清理临时目录和已创建 pane；
8. `subagent_visible` 使用相同回退策略；
9. 现有 subagents 测试全部通过。

真实 smoke test分别验证：当前 Herdr 会话创建可见 pane；移除 Herdr/tmux 环境后同步完成并显示回退原因。

## 修改范围

- `extensions/subagents/index.ts`
- 必要时把小型纯调度判断放入 `extensions/subagents/visible-helpers.ts`
- `extensions/subagents/test/` 下的针对性测试
- `extensions/subagents/README.md`
- `AGENTS.md`

不修改 agent 定义、模型配置、并发上限或可见子进程协议。

## 非目标

- 不增加新的 mux 后端；
- 不根据任务长度、agent 类型等启发式决定是否可见；
- 不在可见任务已经启动后自动重试；
- 不增加 `delegate`、`subagent_sync` 等新工具；
- 不顺带修改 Herdr 焦点检测或其他无关行为。
