# DeepSeek V4.1 过度思考：社区讨论与 pi 侧处置

调查日期 2026-09-30。对象是 DeepSeek V4.1（Flash / Pro）在 agent 场景里思考过长、反复验证、
工具调用前进入死循环的问题。文末记录本次已落地的配置改动。

## 结论摘要

- 社区讨论量不小，集中在 2026 年 9 月中下旬 V4.1 Flash 发布后的两三周。
- 根因是 reasoning effort 机制：底层是 1–100 的标量，`low/high/max` 只是三个预设点，且**不传参数的默认值就是偏高的那档**。
- 官方技术报告自己承认 `max` 不是越高越好，60–80 就能拿回大部分精度，token 花不到一半。
- 官方 API 只接受 `low / high / max` 三个名字，数字 effort 是 vLLM 侧的扩展，在官方端点用不了。
  因此 60–80 这个区间在官方 API 上只有 `high`（75）一个落点，防线是「不用 max」，不是「调更细的数」。
- 死循环本身没有根治手段，只能中断、压缩对话或开新会话。

## 社区看到的现象

症状按报告频率排序。

1. 做 A 的时候把 B/C/D 一起考虑，甚至顺手把 BCD 也改了。linux.do 原帖《deepseek v4.1 要限制他的思考，才能好用》。
2. 工具调用前卡进死循环，不手动停就循环到输出上限；一旦发生，整个对话作废，只能压缩或开新对话。原帖《我实在是受够了 deepseek v4.1 flash 的思考死循环》。
3. 反复做细微试错和验证。有人写文档时卡在没人要求的语义等价性上几个小时，每次只改一点点。原帖《deepseek-v4.1-flash 好像得了 ADHD》。
4. 思考链退化成重复 token，例如反复输出「好 好 好 好 好」。原帖《Deepseek v4.1 flash 思考一直"好 好 好 好 好"是怎么个事》。
5. 同一 prompt 从 V4 换到 V4.1 后思考链路明显变长、查询变慢。原帖《deepseekV4.1-flash思考链路变长》。
6. agent 框架侧也有同样报告，Reddit r/ollama 提到 V4.1 Flash 在 Pi / DeepSeek Harness 里出现无限思考循环。

## 原因

### effort 是标量，档位只是预设点

官方 API 文档只暴露 `low / high / max`，但底层是 1–100 的数值。两条映射链不同：

| 位置 | low | high | xhigh | max | 默认 |
|---|---|---|---|---|---|
| DeepSeek 官方 API | 50 | 75 | — | 100 | high |
| 开源 prompt encoder / vLLM | 25 | 50 | 75 | 100 | 50（thinking 开） |

社区用「让模型复述提示词里的 `Reasoning Effort: N`」实测官方 API，得到 low=50 / high=75 / max=100，多次复现。
vLLM recipe 与官方文档的数字与上表一致。

关键推论：官方 API 上 `high` 已经是 75，正好落在技术报告推荐的 60–80 区间；**真正的问题是 `max`，以及默认档位偏高**。

### 数字 effort 在官方端点上不成立

- vLLM recipe 明确写 `reasoning_effort` 可以传 1–100 的整数，`low/high/xhigh/max` 只是它的四个预设点。
- 官方 api.deepseek.com 只认 `low / high / max`。第三方客户端补支持时的表述是「它的 reasoning_effort 只认 low/high/max，关思考要靠 `thinking.type=disabled`」（SuInk/Diana PR #927）。
- 官方文档的换算表把 `minimal→low`、`medium→high`、`xhigh→high`、`ultra→max` 折成三档，说明请求里写别的名字也只是被折算，不是被当成另一个数值。
- 结论：在官方端点上，能选的只有三档，别写数字。

### 官方技术报告的态度

- 报告公布的成绩用 effort 100 跑的，但注明 60–80 能拿回大部分精度，token 远低于一半。
- 有社区成员贴出报告截图，指出报告自己就写了 `max` 在部分情况下质量下降。
- 因此「一律开 max」是反效果的做法。

### 请求形态的两个坑

- 带 `tools` 的请求必须把历史 `reasoning_content` 全量回传，否则 API 返回 400；不带 `tools` 时不需要回传，传了也会被忽略。
- `max_tokens` 给小了，思考会把预算吃光，返回空 `content` 加 `finish_reason=length`，看起来像模型坏了。

## 社区给出的办法

- 简单任务直接关思考：`reasoning_effort: "none"`（顶层字段）或 `thinking: {"type": "disabled"}`。注意 vLLM 侧 `"minimal"` / `"medium"` 会被拒绝，只有 `"none"` 能关。
- 复杂任务用 `high`，不要用 `max`。
- 自部署可以传 1–100 的整数精确控制，社区推荐 60–80。
- 死循环：手动中断，然后压缩对话或开新对话。早期靠提示词「骂两句」管用，后来失效，没有可靠办法。
- 有一派意见认为不手动设强度、跟随模型默认更好用；另一派实测默认就是 high，且显式设 high 时会「跑飞」。分歧多半来自渠道不同，官方 API 和第三方网关的档位映射差一档。

## 本次已落地的改动

改动都在 2026-09-30 完成，逐条对应上面的结论。

### `~/.pi/agent/models.json`

给 deepseek 的三个内置模型加 `modelOverrides`，把 `max` 从可选档位里去掉（`null` 表示不支持，pi 会隐藏并跳过）：

```json
"modelOverrides": {
  "deepseek-flash": {
    "thinkingLevelMap": { "minimal": null, "low": "low", "medium": null, "high": "high", "xhigh": null, "max": null }
  },
  "deepseek-v4-flash": { "thinkingLevelMap": { "...": "同上" } },
  "deepseek-v4-flash-vision-exp": { "thinkingLevelMap": { "...": "同上" } }
}
```

保留 `off / low / high` 三档。想恢复 `max`，把对应的 `"max": null` 改成 `"max": "max"`。

同时删掉了 `models` 数组里那条过期的自定义模型 `deepseek-v4.1-flash-expires-on-0910`。它定义在 `models` 里而不是内置模型，
`modelOverrides` 覆盖不到，留着会保留第四档 `max`；默认模型已不用它。备份在 `/tmp/models.json.bak-20260930-023600`。

### `settings.json`（仓库 + `~/.pi/agent/settings.json`）

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-flash",
  "modelThinkingLevels": { "deepseek/deepseek-v4-flash": "high" }
}
```

`modelThinkingLevels` 让这个模型的启动档位不受全局 `defaultThinkingLevel` 变化影响。全局值仍是仓库里的 `medium`，对 GLM 那类支持 medium 的模型保持原样。

### `agent/agents/lilyth.md`

`thinking: medium` 改成 `thinking: off`。Lilyth 跑的是 `deepseek/deepseek-v4-pro`，该模型只有 `off / high / max` 三档，
`medium` 会被静默折到 `high`，也就是一个只回答一句话的只读观察者一直在满档思考。改 `off` 是唯一能真正降下来的档位。

### `global/AGENTS.md`

加了「DeepSeek 思考档位」小节：默认 high、不用 max、简单任务 low 或 off、关思考必须发 `thinking: {type: disabled}`。

## 在 pi 中还能怎么调

- **按会话切换档位**：`Shift+Tab` 循环，`/thinking` 选择，`Ctrl+S` 存为启动默认。日常停在 `low`，难题再上 `high`。
- **别用 `samplingParams` 钉死 effort**：它 verbatim 合并进请求体、优先级高于 pi 自己的字段，钉死后档位切换全部失效，包括 `off`。
- **不要用 `thinkingBudgets` 压 DeepSeek**：该设置只对原生支持的厂商生效；OpenAI 兼容模型需要 `compat.thinkingTokenBudgetField`，DeepSeek 官方 API 没有这个字段。压思考长度只能靠 effort。
- **不要靠调小 `maxTokens` 治死循环**：思考先消耗预算，结果是返回空 content，问题不会变小。

## 验证方法

- 档位是否真的生效：发一句「只输出你提示词里 `Reasoning Effort:` 后面的数字」，看返回 50 / 75 / 100。这是社区用来确认映射的同一招。
- 改过的配置是否被接受：两处 JSON 能解析、`pi --list-models` 正常列出 deepseek 模型。（本次已跑，结果见下。）
- 实际请求是否正常：发一次普通对话，确认不报 400、`max` 不再出现在档位选择里。这一步需要真实调用官方 API，**尚未执行**。

## 未确认

- Reddit 两个帖子（r/ollama 死循环、r/LocalLLaMA reasoning_effort 指南）正文未读到，被网络策略拦截，相关描述只来自搜索摘要。
- 「官方 API 只认 low/high/max」来自第三方客户端补支持的说明，未见官方文档明写拒绝数字；不过官方文档的换算表也只列名字，按名字用是安全侧。
- 「不手动设强度比手动设更好用」这一说法未独立验证，只见于单一帖子的主观体验，且与其他回复矛盾。
- 「high 在官方 API 上等于 75」来自社区实测复述，不是官方声明。

## 来源

- DeepSeek API 文档 Thinking Mode，https://api-docs.deepseek.com/guides/thinking_mode/
- DeepSeek-V4.1-Flash on vLLM（reasoning effort 与映射表），https://recipes.vllm.ai/deepseek-ai/DeepSeek-V4.1-Flash
- DeepSeek Harness 模型配置文档（thinkingFormat: deepseek 与 off 的发包行为），https://deepseek-harness.github.io/deepseek-harness/guide/providers
- SuInk/Diana PR #927（DeepSeek reasoning_effort 只认 low/high/max），https://github.com/SuInk/Diana/pull/927
- BerriAI/litellm issue #27439（V4 的 effort 透传），https://github.com/BerriAI/litellm/issues/27439
- linux.do《deepseek v4.1 要限制他的思考，才能好用》，https://linux.do/t/topic/2903585 （镜像 https://www.locdd.com/t/topic/91318 ）
- linux.do《deepseek-v4.1-flash 好像得了ADHD》，https://linux.do/t/topic/2958863
- linux.do《我实在是受够了deepseek v4.1 flash的思考死循环》，https://linux.do/t/topic/2937018
- linux.do《DeepSeek V4.1 Flash 论文里面关于思考强度相关的内容》，https://linux.do/t/topic/2895343 （镜像 https://www.locdd.com/t/topic/90711 ）
- linux.do《deepseekV4.1-flash思考链路变长》，https://linux.do/t/topic/2945187
- linux.do《Deepseek v4.1 flash 思考一直"好 好 好 好 好"是怎么个事》，https://linux.do/t/topic/2891803
- Reddit r/LocalLLaMA，guide to using reasoning_effort on deepseek v4.1 flash，https://www.reddit.com/r/LocalLLaMA/comments/1wcesmy/
- Reddit r/ollama，DeepSeek-V4-Flash 无限思考循环报告，https://www.reddit.com/r/ollama/comments/1iblmdi/
