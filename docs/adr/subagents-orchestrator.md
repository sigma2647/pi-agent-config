# ADR：不为 subagents 默认启用 always-on orchestrator

- 状态：已接受
- 日期：2026-07-17
- 范围：`extensions/subagents`

## 背景

`pi-interactive-subagents` 已提供异步子代理工具、角色定义、并行派遣、mux 生命周期管理和 steer 自动回传。仓库还包含 `/plan` 工作流，以及 `scout`、`researcher`、`planner`、`worker`、`reviewer` 等 agent 定义。

曾考虑为其增加一个自动、常驻的 orchestrator，通过 system prompt 或 `promptGuidelines` 指导主代理在每个任务中主动选择和派遣子代理。

为判断是否有必要，分别通过 OpenCLI、`pi-ws` 和 `browser-probe search` 做了三路独立调研，比较以下模式：

1. 主模型依据 tool description 自主委派；
2. always-on system prompt / `promptGuidelines`；
3. skill / command 按需加载；
4. 扩展状态机或硬编码 router 自动派遣。

三路调研结论一致：当前架构已经合理，不应在没有实际问题和评测证据时增加默认 orchestrator。

## 决策

维持当前的分层设计，不为 `subagents` 默认启用 always-on orchestrator：

- `subagent` tool description / `promptSnippet` 负责异步调用、自动回传、禁止轮询等不变规则；
- `agents/*.md` 负责各角色的工具权限、职责和执行策略；
- `/plan` 和其他 skill / command 负责固定、复杂、可预测的编排流程；
- 主代理根据当前任务决定是否委派，并负责整合和验证结果；
- 不增加自动任务分类器、默认 Scout → Worker → Reviewer 流水线或硬编码 router；
- 不默认允许递归派遣或多个 writer 并发修改共享 checkout。

现有 `skills/orchestrator/SKILL.md` 保持为按需能力，不设为 always-on。它与实际 agent 定义的内容偏差应作为独立问题修正，例如其中称 `worker` 可以继续派生子代理，而 `agents/worker.md` 实际配置为 `spawning: false`。

## 理由

### 当前机制已经覆盖核心场景

| 场景 | 当前机制 |
|---|---|
| 开放式临时委派 | `subagent` 工具 |
| 固定复杂规划 | `/plan` + `plan-skill.md` |
| 并行研究或探索 | 同一轮启动多个 subagent |
| 完成后继续主会话 | steer 自动回传并唤醒 |
| 人工指定专家 | `/subagent` |
| 恢复旧子会话 | `subagent_resume` |
| 防止无限递归 | `spawning: false` |

新增中央 orchestrator 会与主代理现有决策职责重叠。

### 多代理只在特定任务结构中稳定获益

适合委派的任务通常是：

- 多个独立、有界、可并行的研究方向；
- 大型代码库不同区域的只读探索；
- 相互独立的 bug 假设或 review 视角；
- 能用简短结果压缩大量搜索、日志或文件内容的子任务。

不适合默认委派的任务通常是：

- 小修改；
- 强顺序依赖；
- 同一文件或共享状态的并发写入；
- 需要频繁同步父子上下文；
- 单个慢外部操作；
- 固定且要求确定性的执行图。

Anthropic 公布的多代理研究系统在适合并行研究的任务上取得明显收益，但约消耗普通聊天 15 倍 token，并指出 coding task 的实际并行度通常低于研究任务。

### Always-on prompt 不能提供确定性

常驻 orchestrator 指令只能改变模型选择委派的概率，不能把软决策变成可靠状态机。它还会：

- 在不需要委派的每轮请求中消耗上下文；
- 增加与 AGENTS.md、skills 和 tool description 冲突的可能；
- 诱发简单任务过度派遣；
- 固化不一定适合所有项目和任务的角色路由。

复杂流程更适合按需加载，以保持上下文中的规则少而明确。

## 否决的方案

### Always-on `promptGuidelines`

否决宽泛规则，例如“所有非简单任务都应使用 subagents”。它会增加过度委派风险，但无法保证正确调用。

### `before_agent_start` 注入完整 orchestrator

技术上可行，但每轮都携带较长策略，容易形成第二套系统提示。当前没有证据证明其收益超过上下文成本和规则冲突。

### 自动分类器或状态机

不为开放式 coding task 增加关键词、文件数、提示长度或额外模型调用驱动的 router。分类、状态恢复、错误传播和结果聚合会显著增加复杂度。

状态机只适用于 `/plan`、批量审查等边界明确且流程稳定的显式模式。

### 新增 orchestrator agent

不增加负责二次调度的子代理。该方案会引入额外决策中心、上下文交接和“谁调度调度器”的问题。

## 后果

### 正面

- 保持扩展机制简单、可组合；
- 普通任务不承担额外 token 和延迟；
- 用户和项目可以通过 skill、command 或 AGENTS.md 选择工作流；
- 主代理继续拥有最终判断、整合和验证责任；
- 避免不必要 fan-out、重复读取和并发写入冲突。

### 负面

- 主模型可能偶尔漏派适合的子任务；
- 不同模型的主动委派倾向可能不同；
- 固定复杂流程仍需用户或模型显式触发 `/plan` 或相应 skill。

这些问题目前没有造成明确使用障碍，不足以支持增加全局编排层。

## 重新评估条件

只有出现可重复的实际问题时才重新评估，例如：

- 复杂任务多次明显漏用 scout 或 researcher；
- 大量搜索内容持续污染主上下文；
- 可并行任务长期被串行执行并造成明显延迟；
- 缺少独立 review 导致可验证的质量下降。

第一步应是最小增强，例如在 tool description 中增加一句保守规则：

> Use subagents for independent parallel work, context-heavy investigation, or fresh-context review. Prefer direct tools for trivial or tightly sequential work.

若仍考虑自动 router，必须先用真实 coding tasks 比较以下指标：成功率、首次正确率、模型调用数、token、墙钟时间、不必要 spawn 率、重复读取率和人工纠正次数。

## 参考资料

- [Claude Code: Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic: Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [OpenAI Agents SDK: Multi-agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)
- [OpenAI: Agents orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration)
- [LangChain: Multi-agent](https://docs.langchain.com/oss/python/langchain/multi-agent)
- [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
