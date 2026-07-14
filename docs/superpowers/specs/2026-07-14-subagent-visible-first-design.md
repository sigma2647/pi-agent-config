# Subagent 默认可见优先设计

**日期：** 2026-07-14

## 目标

让 `subagent` 优先使用现有的 Herdr/tmux 可见执行路径；仅在不存在受支持的实时复用器目标时，回退到同步执行。同时修复 Herdr 检测逻辑，避免父 pane 仅因当前未获得焦点而被错误拒绝。

## 当前问题

`detectVisibleTarget()` 会调用 `herdr pane current`，并且仅在返回结果满足 `focused === true` 时接受该 pane。用户把焦点切换到其他 pane 后，Pi 进程仍然运行在有效的 Herdr pane 中。此时 Herdr 已注入 `HERDR_ENV=1` 和 `HERDR_PANE_ID`，但检测仍返回 `null`，导致 `subagent_visible` 误报不存在实时复用器。

## 行为设计

### `subagent`

1. 与当前行为一致，解析并校验指定的 agent。
2. 检测受支持的可见目标。
3. 如果存在目标，通过现有的异步可见 subagent 生命周期启动，并立即返回。
4. 如果不存在目标，通过现有的同步无界面生命周期运行。
5. 如果已经检测到目标，但 pane 创建或启动失败，则直接返回启动错误，不再静默回退到同步执行。

根据所选生命周期，返回结构和渲染方式可以不同：可见启动返回现有的已启动/pane 确认信息；同步回退返回 agent 完成后的结果。

### `subagent_visible`

保留为显式的严格可见工具。不存在受支持的实时复用器时不进行同步回退，并保留当前错误行为。

### Herdr 目标检测

使用父进程身份，而不是 UI 焦点判断目标：

1. 当 `HERDR_ENV=1`、`HERDR_PANE_ID` 非空且 `herdr` 命令可用时，使用 `HERDR_PANE_ID` 作为分割锚点。
2. 否则保留现有的 `herdr pane current` 兜底及其焦点校验，避免在无法确认当前进程属于 Herdr 时选中无关的全局焦点 pane。
3. 保持现有 tmux 检测和显式后端偏好行为不变。

该设计遵循 Herdr 公开的 pane 环境变量约定，也与本地 `pi-interactive-subagents` 使用继承的父复用器 pane ID、而非当前 UI 焦点来确定目标的做法一致。

## 提示词和命令入口

更新 `subagent` 的描述和指导，说明它默认可见优先，仅在不存在实时复用器时同步回退。`subagent_visible` 的描述继续明确其严格可见语义。`/subagent` 命令应用相同的可见优先行为，确保工具和命令语义一致。

## 测试

增加针对性回归测试，证明：

- 即使 `herdr pane current` 返回 `focused: false`，Herdr 检测仍接受有效的 `HERDR_PANE_ID`。
- 缺少 Herdr 运行标记或 `herdr` 命令时，不会把环境中的 pane ID 当作有效目标。
- 目标检测成功时，`subagent` 选择可见执行。
- 仅当目标检测返回空时，`subagent` 才选择同步执行。
- 可见启动失败时直接暴露错误，不触发同步回退。
- 现有严格 `subagent_visible` 行为不变，完整 subagents 测试保持通过。

## 非目标

- 不增加新的复用器后端。
- 不增加重试、智能路由，也不在已检测到复用器但启动失败后回退。
- 不增加新的用户可见模式参数。
- 不删除 `subagent_visible`，也不将其改为别名。
- 不修改可见 pane 生命周期、自动退出、恢复、中断或完成结果投递机制。
