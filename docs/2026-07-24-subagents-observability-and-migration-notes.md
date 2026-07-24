# Subagents 可观测性与迁移参考记录

> 日期：2026-07-24  
> 状态：研究记录；当前不实施  
> 范围：`extensions/subagents` 当前 vendored 实现，以及 `/Users/lawrence/repo/repo-agent/my-pi-setup/extensions/subagents` 的参考实现

## 1. 当前结论

当前 `pi-agent-config/extensions/subagents` 可以运行且测试通过，应继续作为主线。不要因为另一个实现更优雅而重构或迁移。

`my-pi-setup/extensions/subagents` 可作为设计参考，尤其是后端抽象、标准事件模型、`subagent_check` / `subagent_wait` 等管理语义；但不建议整体迁移，也不建议为了未来可能性引入 Effect v4 或重写 mux 子进程模型。

## 2. 未来潜在修改方向

### 2.1 优先级最高：低 token 可观测性

真实痛点不是同步等待，而是：当 subagent 仍在运行时，主 agent 需要按需观察它正在做什么，并用很少 token 回复用户。

建议优先考虑 `subagent_check` 或 `subagent_observe`，而不是 `subagent_wait`。

默认反馈应只包含低成本状态：

- subagent `id` / `name` / `agent`；
- 当前状态：`starting` / `active` / `waiting` / `stalled` / `running`；
- 当前活动范围：`agent` / `turn` / `provider` / `streaming` / `tool`；
- 当前工具名、工具持续时间、最近事件；
- activity snapshot 健康状态：present / missing / invalid / wrong-id；
- session file / surface / launch script 路径（必要时用于人工排查）。

不要默认返回完整 transcript、完整 session JSONL、大段屏幕输出或工具输出。

### 2.2 灵活输出证据，而不是固定“五行”

如果用户问“里面具体输出了什么”，可以按需读 mux pane 屏幕，但不要固定为 5 行。更灵活的方式是按预算截断：

- `detail: "status" | "auto" | "screen" | "debug"`；
- `maxBytes` 默认约 1000，最大约 4000；
- `maxLines` 作为上限，不作为核心语义；
- 清理 ANSI、空行和过长内容；
- 从尾部向前选取最近可见输出，直到达到预算。

`auto` 模式建议：

- provider / streaming：只返回状态，不读屏幕；
- tool active：返回状态 + 小段 screen evidence；
- waiting：只返回 waiting 状态和等待时长；
- stalled：返回状态 + 最后事件 + 当前工具 + 小段 evidence。

### 2.3 可选增强：tool preview

如果 Pi 的 `tool_execution_*` 事件能提供参数或输出片段，未来可在 activity JSON 中记录：

- `toolArgsPreview`；
- `toolOutputPreview`。

这比读整屏更省 token，也更适合 batch / bash 长命令。但只有在事件本身可靠暴露这些字段时才做，不要猜。

### 2.4 `subagent_wait` 暂不优先

`subagent_wait` 的价值是确定性 fan-in：启动多个 subagent 后，明确等全部结果再综合。

但当前主线的核心体验是 fire-and-forget + steer 自动回流。过早加入 wait 可能诱导模型每次 spawn 后立即阻塞，削弱并行能力。

只有出现以下实际痛点时再考虑：

- 主 agent 经常在结果回来前错误推进；
- 固定需要“多个 scout 全部完成后再综合”；
- steer 到达时机经常扰乱工作流；
- 需要可测试的批量 fan-in 流程。

## 3. 当前实现已可利用的观测源

当前 `pi-agent-config/extensions/subagents` 已有这些可观测来源：

| 来源 | 文件 | 可提供信息 | 默认是否应反馈给主 agent |
|---|---|---|---|
| `runningSubagents` | `pi-extension/subagents/index.ts` | id/name/agent/surface/sessionFile/startTime/interactive | 是 |
| activity snapshot | `pi-extension/subagents/activity.ts` | latestEvent、phase、activeScope、toolName、activeSince、waitingSince | 是 |
| status state | `pi-extension/subagents/status.ts` | active/waiting/stalled、snapshot 健康、状态转换 | 是 |
| mux screen | `pi-extension/subagents/cmux.ts` | Herdr/tmux/cmux/zellij/wezterm pane 可见输出 | 仅按需 |
| session JSONL | `pi-extension/subagents/session.ts` | 最终 assistant 消息、resume/lineage/fork 信息 | 仅完成或 debug 时 |
| launch script | launch artifact | 实际启动命令 | 仅 debug 时 |

## 4. 未来迁移参考

### 4.1 当前主线保留项

应保留 `pi-agent-config/extensions/subagents` 的这些能力：

- mux pane + 子进程隔离；
- Herdr/cmux/tmux/zellij/WezTerm 支持；
- agent frontmatter 系统；
- `context-files: all|project|none`；
- `session-mode: standalone|lineage-only|fork`；
- `auto-exit` / `interactive`；
- `/plan`、`/iterate`、`/subagent`；
- steer 自动回传；
- status widget 与 stalled/recovered 监督。

这些是当前实现的生产价值，不应为架构洁癖牺牲。

### 4.2 可从 my-pi-setup 参考的部分

`/Users/lawrence/repo/repo-agent/my-pi-setup/extensions/subagents` 中值得参考但不急着搬迁的点：

- `src/backend.ts`：统一 `SubagentBackend` / `SubagentSession` 接口思想；
- `src/domain.ts`：标准化 `SubagentEvent` / `SubagentSnapshot`；
- `src/manager.ts`：wait/check/cancel 的任务管理语义；
- `src/result-delivery.ts`：结果延迟投递、避免 wait 与自动回传重复；
- `src/by-the-way.ts`：`/btw` 侧线模式；
- `src/backends/claude.ts`、`src/backends/codex.ts`：原生 SDK / app-server 事件接入思路。

若未来吸收，优先把这些思想改写成普通 TypeScript/async 接口，不直接引入 Effect v4。

### 4.3 不建议迁移的部分

- 不整体迁移到 `my-pi-setup`；
- 不用 in-process backend 替换默认 mux backend；
- 不放弃现有 frontmatter agent 系统；
- 不放弃 context-files / session-mode；
- 不为了 `subagent_wait` 重写现有 steer 工作流；
- 不引入常驻 orchestrator 或自动 router。

## 5. 重新评估条件

只有出现可重复的实际问题时再进入实现：

- 用户经常问“subagent 里面在干嘛”，且当前 UI 不足以让主 agent低成本回答；
- batch/bash 长命令缺乏可见进度，导致误判 stalled；
- 多 subagent fan-in 成为高频需求；
- mux 文件轮询或 screen 读取成为稳定性瓶颈；
- 需要正式支持 Claude SDK / Codex app-server 的结构化事件；
- 当前 vendored 实现难以维护，必须拆出 backend/snapshot 层。

第一步应是最小改动：增加低 token 的 `subagent_check` / `subagent_observe`，默认只返回状态和 activity；只有用户显式要求时才读取屏幕证据。
