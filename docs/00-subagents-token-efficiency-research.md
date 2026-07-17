# Subagents Token 效率研究

> 日期：2026-07-17  
> 状态：研究记录，尚未形成实施决策  
> 触发来源：Adam Gardner，*[I Cut My OpenCode Token Usage by 96% — Here's How](https://www.youtube.com/watch?v=FX7jcd3GYtI)*

## 1. 核心结论

视频最有价值的结论不是“所有任务都能节省 96%”，而是：

> 智能体的能力表面积（系统提示、工具 Schema、历史上下文和附加技能）是每轮模型请求的固定成本。

“Hello”一类极短输入会放大固定成本占比，因此适合暴露脚手架问题，但不能代表真实编码任务的整体节省比例。优化时应衡量“正确完成一次任务的总 Token”，而不是只衡量首轮输入 Token。

## 2. 视频中的发现

以下数字来自视频，不是本仓库实测结果：

- OpenCode 收到一句 `Hello` 后发起两次模型调用：一次生成标题，一次回答用户。
- 正式请求包含约 9,500 字符的系统提示和 11 个工具的完整 JSON Schema。
- 默认 `build` Agent 消耗约 8,000+ Token。
- 无工具、极短提示的自定义 Agent 约消耗 300–500 Token。
- 所谓 96% 降幅以极短问答为基准；代价是失去读写文件、联网和子智能体等能力。

由此得到的设计原则是：默认能力最小化，重型能力显式启用，从最小工具集开始按需增加。

## 3. 当前 subagents 架构盘点

### 3.1 已经符合该原则的部分

当前 bundled Agent 已按角色限制工具：

| Agent | 工具白名单 | 定位 |
|---|---|---|
| `scout` | `read, bash` | 代码库侦察 |
| `worker` | `read, bash, write, edit` | 隔离修改 |
| `reviewer` | `read, bash` | 只读审查 |
| `researcher` | `web_search, web_fetch` | Web 研究 |
| `visual-tester` | `bash, read, write` | 视觉验证 |
| `planner` | 未设置静态白名单 | 重型编排 |
| `claude-code` | 未设置静态白名单 | 外部 CLI Agent |

多数执行型 Agent 还设置了 `spawning: false`，会禁用子 Agent 生成相关工具。这说明当前架构已经优于“所有 Agent 默认加载全部工具”的模式。

### 3.2 主要固定成本来源

#### Agent body 偏长

bundled Agent 的 Markdown body 会成为子 Agent 的身份/系统提示。盘点发现：

- bundled `agents/scout.md` 约 250 行，包含大量 bash 示例和输出模板。
- bundled `agents/planner.md` 约 630 行、约 19KB，包含完整阶段流程和多处调用示例。
- `worker`、`reviewer` 也重复描述部分通用原则、流程和格式要求。

本机 `~/.pi/agent/agents/` 中的全局覆盖版本明显更短：

- `scout` 约 40 行、约 1.9KB。
- `planner` 约 30 行、约 1.1KB。

这说明精简版本在现有机制内已经可行，但 bundled 默认仍然偏重。全局覆盖是本机状态，不等于仓库默认行为。

#### 工具说明可能重复

`pi-extension/subagents/index.ts` 中，`subagent` 和 `subagent_resume` 的 `description` 与 `promptSnippet` 存在高度重复的说明文本。

目前只能确认源码文本重复，尚未确认 Pi 是否会把两份内容同时放入 provider 请求。删除前必须抓取实际请求 payload 或核对 Pi 运行时实现，不能直接把字符数当作 Token 节省量。

#### `/plan` 内联完整 skill

`/plan` 会读取完整 `plan-skill.md`，去除 frontmatter 后放入用户消息。该行为属于显式重型规划路径，未必需要优化，但应计入规划任务的上下文成本。

## 4. 推荐的能力分层

### 4.1 无工具问答（可选）

如果用户经常在 Pi 内进行概念解释、设计讨论或文本润色，可增加一个极短、无工具的 `ask` Agent：

- 极短系统提示；
- 不暴露文件、网络或子 Agent 工具；
- 明确不能对未读取的仓库状态作事实判断。

如果纯问答使用频率很低，直接使用普通聊天入口更简单，不值得新增 Agent。

### 4.2 专家 Agent（保持现状）

继续使用静态最小白名单：

- 查代码：`scout`
- 查网页：`researcher`
- 改代码：`worker`
- 审查：`reviewer`

不建议为每种微小任务继续增加 `scout-lite`、`worker-lite` 等变体。Agent 数量、选择规则和维护成本会反过来扩大脚手架。

### 4.3 重型编排（显式启用）

`planner`、多 Agent 协作和完整工具集应保持显式入口，不作为普通问答默认路径。

不建议先调用一个模型自动判断该使用哪个模式；额外分类调用会重演视频中“回答之前先生成标题”的固定开销。简单、可预测的显式模式优于智能自动路由。

## 5. 优先级建议

### P0：建立真实基线

选择约 10 个代表性任务进行 A/B 测试，记录：

- uncached input Token；
- cache-read Token；
- output Token；
- 工具调用次数；
- 重试次数；
- 最终是否正确完成。

主指标：

> 正确完成一次任务的总 Token 和总成本。

短问答、单文件调查、多文件修改、Web 研究和重型规划应分别统计，不能用 `Hello` 的百分比外推真实编码任务。

### P1：压缩 bundled Agent body

优先对 `planner` 和 `scout` 做 A/B 测试：

- 删除 bash 使用教程；
- 删除大段调用示例；
- 缩短输出模板；
- 合并重复约束；
- 保留身份、权限边界、证据纪律和交付格式。

现有全局精简版可作为候选基线，但不能未经质量验证直接替换 bundled 默认。

### P1：验证工具说明重复

抓取一次实际 provider payload，确认 `description` 和 `promptSnippet` 是否都进入模型上下文。只有确认重复后才删除，避免基于源码字段作错误优化。

### P2：按使用频率决定是否增加 `ask`

只有纯问答在 Pi 内高频发生时才增加无工具 Agent。否则不新增配置。

## 6. 不建议实施的“优化”

| 提议 | 判断 | 原因 |
|---|---|---|
| 将 `session-mode` 改为 `fork` | 不建议 | Fork 会继承父会话上下文，可能增加而不是减少 Token。 |
| 为短任务跳过 artifact 文件 | 低价值 | 主要减少文件 I/O；artifact 路径本身不是主要模型成本。 |
| 用 `disable-model-invocation` 做轻量问答 | 不成立 | 禁用模型后无法完成自然语言问答，只适合纯工具流程。 |
| 自动识别任务并动态选择 Agent | 不建议 | 增加分类调用、失败路径和路由复杂度。 |
| 建立大量 `*-lite` Agent | 不建议 | 配置数量和选择成本会反噬收益。 |
| 删除 `deny-tools: claude` 以节省 Token | 可清理但非优化 | 该配置疑似不匹配注册工具，但删除几乎没有 Token 收益。 |

## 7. 验证假设

后续实施前需要验证：

1. Pi 实际发送给 provider 的系统提示、工具 Schema 和 `promptSnippet` 组成。
2. 当前 provider 是否缓存系统提示和工具定义，以及缓存计费方式。
3. 精简 Agent body 后，任务成功率和重试次数是否恶化。
4. 本机全局 Agent 覆盖与仓库 bundled Agent 的实际解析优先级。
5. Pi 是否存在类似 OpenCode 的自动标题生成额外模型调用；不能把视频中的 OpenCode 行为直接假定为 Pi 行为。

## 8. 决策摘要

推荐顺序：

1. 抓取并拆分真实请求 Token；
2. A/B 测试精简 bundled `planner` / `scout`；
3. 验证并删除真正进入上下文的重复工具说明；
4. 最后再根据使用频率决定是否增加无工具 `ask` Agent。

总体原则：

- 默认能力最小化，重型能力显式启用；
- 工具按角色使用静态白名单，不做智能自动路由；
- 提示词保留必要规则，删除教程和重复示例；
- 按正确完成任务的总成本优化，不按极短输入的百分比优化。
