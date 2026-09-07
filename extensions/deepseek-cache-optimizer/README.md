# deepseek-cache-optimizer（pi 扩展）

优化 DeepSeek 官方 API 的自动前缀缓存命中率。方法来自 DeepSeek Harness（`deepseek-ai/deepseek-harness`）的缓存设计，移植到 pi 扩展体系。

## 原理一句话

DeepSeek 的缓存是自动的：请求前缀从第 0 字节起与之前完全一致才命中，命中价便宜 50~120 倍。所以一切优化都围绕「让请求前缀稳定」。

## 三个模块

| 模块 | Hook | 做什么 | 默认 |
|---|---|---|---|
| 1. CWD 前缀稳定化 | `before_agent_start` + `context` | 把 pi 缝在 system prompt 末尾的 `Current working directory` 动态行移出，改为**每轮**消息流尾部追加固定文本。system prompt 从此完全静态，工具循环不重复插入 | 开 |
| 2. 压缩前缀复用 | `session_before_compact` | 接管压缩：压缩请求 = system prompt + 历史消息重放 + 末尾压缩指令，意图命中热缓存 | **关** |
| 3. 命中率遥测 | `message_end` + `/cache-stats` | 统计累计缓存命中率，持久化到磁盘 | 开 |

只对 DeepSeek 模型生效（provider=deepseek 或模型 id 含 deepseek），其他模型完全不动。

### 模块 2 为什么默认关

压缩请求不带 `tools` 字段，而主请求带 tools；DeepSeek 把 tools 渲染进 prompt 前缀，因此压缩请求的前缀在 system 之后即与主请求分叉，只能命中 system 那一小段，历史消息整段 miss——「复用热前缀」的核心收益基本不成立。同时该路径相比 pi 原生压缩丢失了结构化摘要与 fileOps 追踪。故默认关闭，走 pi 原生压缩；如需实验可用 `PI_DSC_COMPACTION_PREFIX=1` 打开。

## Subagent 兼容

pi-interactive-subagents 等方案 spawn 的子代理是**独立的 pi 进程**（`pi --session <file> -e ...`），它们读同一份全局 `~/.pi/agent/settings.json` 和全局扩展目录。本扩展经 `settings.json` 的 packages 链（`pi-agent-config` → `+extensions/deepseek-cache-optimizer/index.ts`）加载后，**子代理进程自动继承**，无需修改 subagents 扩展本身。

子代理会话内同样获得：CWD 前缀稳定（`--append-system-prompt` 追加的 agent body 固定，system prompt 仍静态）、命中率遥测。

## 安装与验证

扩展位于 `extensions/deepseek-cache-optimizer/`，直接作为 `pi.extensions` 入口加载。改完在 pi 内 `/reload`：

1. 正常对话几轮，看 footer 的 `CH:XX.X%`（每轮命中率）。
2. 输入 `/cache-stats` 看累计命中率（跨 `/reload`、跨重启保留）。
3. 子代理场景：spawn 一个 deepseek 模型的 subagent，同样 `/cache-stats` 验证。

## 开关

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_DSC_ENABLED` | 1 | 总开关 |
| `PI_DSC_CWD_MOVE` | 1 | 模块 1 |
| `PI_DSC_COMPACTION_PREFIX` | **0** | 模块 2（不推荐打开，见上） |
| `PI_DSC_TELEMETRY` | 1 | 模块 3 |
| `PI_DSC_STATS_PATH` | `~/.pi/agent/extensions/deepseek-cache-optimizer/stats.json` | 统计落盘路径覆盖 |

## 命中率口径

`hit rate = cacheRead / (input + cacheRead + cacheWrite)`。pi 对 DeepSeek 的 usage 映射是 `input = prompt_tokens - cacheRead - cacheWrite`（即未命中 token），三者互斥相加才是总 prompt token，因此分母必须是三者之和。

## 已知取舍（v2）

- 模块 2 默认关：不带 tools 导致压缩请求前缀命中有限，且丢结构化摘要/fileOps。
- 统计为**累计值**（跨会话/进程），不做按会话拆分；防抖落盘 500ms，进程被强杀时最多丢最后约半秒的统计。
- 落盘失败（如只读 home）静默，不影响会话。
- 压缩失败自动回退 pi 默认压缩，不影响会话。
