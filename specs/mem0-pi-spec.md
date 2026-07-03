# Spec: Mem0 ↔ pi-coding-agent Integration v2

> 2026-07-03 | 状态: 调研完成, 方案选定

---

## 核心发现

### 1. pi 已有 5+ 社区记忆扩展，为什么还要做 Mem0？

| 扩展 | 下载/月 | 存储 | 局限 |
|---|---|---|---|
| pi-hermes-memory | 14.4K | SQLite FTS5 + Markdown | 关键词检索, 无语义搜索 |
| pi-memory | 6.4K | Markdown + 可选 qmd 语义搜索 | 轻量, 但无结构化记忆层 |
| db0 | — | 云端托管 | 第三方服务, 不可控 |

**Mem0 的价值**: 语义搜索 + 图记忆 + 生产级。pi 现有扩展都是"文件文本 + 关键词"，没有真正的向量语义检索和实体关系推理。Mem0 补的是这一层。

### 2. 架构方案选定

**选 B: MCP Server（pi-mcp-extension）**

理由：
- pi 已支持 MCP（通过 `pi-mcp-extension`，7.4K 下载/月）
- Mem0 有社区 MCP server（`coleam00/mcp-mem0`、`elvismdev/mem0-mcp-selfhosted`）
- MCP 比自建 HTTP bridge 标准化, 维护成本低
- 不需要自己写 Python bridge

### 3. Embedding: 可完全本地化 ✅

```python
config = {
    "embedder": {
        "provider": "ollama",
        "config": {"model": "bge-m3", "ollama_base_url": "http://localhost:11434"}
    },
    "llm": {
        "provider": "ollama",
        "config": {"model": "qwen3:4b", "ollama_base_url": "http://localhost:11434"}
    }
}
```

完全本地运行，零 API 成本。需要安装 Ollama + bge-m3 + qwen3。

### 4. Coding Agent 记忆策略

| 类别 | 记什么 | 不记什么 |
|---|---|---|
| 项目上下文 | 技术栈, 架构决策, 构建工具 | 具体文件内容 |
| 用户偏好 | 编码风格, 测试偏好, 命名约定 | 一次性偏好 |
| 代码决策 | 为什么选方案A不是B, bug 根因 | 探索性死胡同 |
| 环境 | 部署目标, 依赖版本, 环境变量 | 瞬时状态 |
| 安全 | **不能记** API keys, 密码, token | — |

### 5. 两个关键 Hook

| Hook | 时机 | 用途 |
|---|---|---|
| `before_agent_start` | 用户提交 prompt 后, agent 循环前 | 注入记忆到 system prompt |
| `context` | 每次 LLM 调用前 | 修改 messages 数组 |

---

## 实现计划

### 阶段一: 搭建 Mem0 MCP Server（Python 端）⭐⭐

复用 `elvismdev/mem0-mcp-selfhosted`（已支持 Qdrant + Ollama），配置为本地嵌入模式。

```
文件: ~/.pi/mem0/mem0-mcp-server/
操作: git clone + 配置 Ollama + 启动
```

### 阶段二: pi 端连接 MCP（TypeScript 端）⭐⭐

安装 `pi-mcp-extension`，配置 mcp.json 指向 mem0 MCP server。

```json
// ~/.pi/agent/mcp.json
{
  "mcpServers": {
    "mem0": {
      "command": "python3",
      "args": ["-m", "mem0_mcp_server"],
      "env": {
        "MEM0_OLLAMA_URL": "http://localhost:11434",
        "MEM0_EMBED_MODEL": "bge-m3"
      }
    }
  }
}
```

### 阶段三: 自动化记忆生命周期 ⭐

写一个轻量 pi 扩展（~50 行 TS），注册三个 hook：

```
before_agent_start  → mem0.search(current_prompt) → 注入 system prompt
agent_end           → mem0.add(user_messages)      → 提取记忆
session_shutdown    → 清理
```

### 阶段四: 自定义提取 Prompt ⭐

针对 coding 场景定制 `custom_instructions`：

```
提取技术事实: 项目上下文 / 用户偏好 / 代码决策 / 环境
排除: 个人信息、闲聊、一次性查询
```

---

## 风险 & 缓解

| 风险 | 缓解 |
|---|---|
| MCP server 崩溃 | pi 降级为无记忆模式, 不阻塞 |
| Ollama 速度慢 (bge-m3 在本地) | 记忆提取离线跑 (agent_end 异步) |
| 记忆膨胀 | 限制 `search` 返回 top-5, 定期审计 |
| 隐私 (对话内容经 embedding) | 全本地 Ollama, 数据不出本机 |
| 与现有 pi-hermes-memory 冲突 | 可共存, 但建议二选一避免重复 |

---

## 待确认

1. pi-mcp-extension 是否稳定（7.4K 下载/月）? 是否需要亲自测试?
2. `elvismdev/mem0-mcp-selfhosted` 是否真能用? 是否需要 fork 修改?
3. 先用 Ollama 还是先用 OpenAI embedding 快速跑通? → 建议先用 OpenAI 验证链路, 再切 Ollama
