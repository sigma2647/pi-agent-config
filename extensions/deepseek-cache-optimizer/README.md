# deepseek-cache-optimizer（pi 扩展）

优化 DeepSeek 官方 API 的自动前缀缓存命中率。方法来自 DeepSeek Harness（`deepseek-ai/deepseek-harness`）的缓存设计，移植到 pi 扩展体系。

## 原理一句话

DeepSeek 的缓存是自动的：请求前缀从第 0 字节起与之前完全一致才命中，命中价便宜 50~120 倍。所以一切优化都围绕「让请求前缀稳定」。

## 三个模块

| 模块 | Hook | 做什么 |
|---|---|---|
| 1. CWD 前缀稳定化 | `before_agent_start` + `context` | 把 pi 缝在 system prompt 末尾的 `Current working directory` 动态行移出，改为每次请求消息流尾部追加固定文本。system prompt 从此完全静态 |
| 2. 压缩前缀复用 | `session_before_compact` | 接管压缩：压缩请求 = 当前 system prompt + 历史消息原样重放 + 末尾压缩指令。让压缩调用命中热缓存（pi 默认压缩用独立 summarizer 且 `cacheRetention: "none"`，放弃复用） |
| 3. 命中率遥测 | `message_end` + `/cache-stats` | 统计进程内累计缓存命中率 |

只对 DeepSeek 模型生效（provider=deepseek 或模型 id 含 deepseek），其他模型完全不动。

## Subagent 兼容

pi-interactive-subagents 等方案 spawn 的子代理是**独立的 pi 进程**（`pi --session <file> -e ...`），它们读同一份全局 `~/.pi/agent/settings.json` 和全局扩展目录。本扩展经 `settings.json` 的 packages 链（`pi-agent-config` → `+extensions/deepseek-cache-optimizer/index.ts`）加载后，**子代理进程自动继承**，无需修改 subagents 扩展本身。

子代理会话内同样获得三项优化：CWD 前缀稳定（`--append-system-prompt` 追加的 agent body 固定，system prompt 仍静态）、压缩前缀复用、命中率遥测。

## 安装与验证

扩展位于 `extensions/deepseek-cache-optimizer/`，直接作为 `pi.extensions` 入口加载。改完在 pi 内 `/reload`：

1. 正常对话几轮，看 footer 的 `CH:XX.X%`（每轮命中率）。
2. 输入 `/cache-stats` 看累计命中率。
3. 触发压缩（长会话自动或 `/compact`），压缩后下一轮 `CH` 应仍高——模块 2 的效果。
4. 子代理场景：spawn 一个 deepseek 模型的 subagent，同样 `/cache-stats` 验证。

## 开关

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_DSC_ENABLED` | 1 | 总开关 |
| `PI_DSC_CWD_MOVE` | 1 | 模块 1 |
| `PI_DSC_COMPACTION_PREFIX` | 1 | 模块 2 |
| `PI_DSC_TELEMETRY` | 1 | 模块 3 |

## 已知取舍（v1）

- 压缩请求不带 tools 字段。OpenAI 兼容格式下 tools 在消息之后，system + 历史消息前缀仍命中；若走某些把 tools 拼在消息之前的代理，命中率会下降。
- 统计为进程级，`/reload` 后清零。
- 压缩失败自动回退 pi 默认压缩，不影响会话。
