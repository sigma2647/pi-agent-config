# pi-wf GitHub 深度研究工作流摩擦评估报告

**日期:** 2026-06-24
**置信度:** 高（所有代码路径均经直接阅读验证）
**来源会话:** `abbd067b-7a9f-4b47-bdda-af9abf98d58e`
**触发上下文:** 将 agent-browser-runtime 深度研究报告 ingest 到 cubox wiki 后，回顾整个 GitHub 数据获取→研究→wiki 入库流程

---

## 1. 审查的关键文件

### pi-wf 源代码
- **CLI 入口:** `extensions/web-fetch/dev.ts`
- **编排器:** `extensions/web-fetch/core.ts`（fallback 链 + FetchContext 设计）
- **GitHub 提取器:** `extensions/web-fetch/extractors/github.ts`（522 行，覆盖 repo/issue/PR/blob/README）
- **提取器注册表:** `extensions/web-fetch/extractors/index.ts`
- **提取器类型:** `extensions/web-fetch/extractors/types.ts`（Extractor 接口 + fetchJson/fetchText 工具函数）
- **引擎:** `extensions/web-fetch/engines/`（defuddle / readability / jina / playwright / pdf / cloakbrowser）
- **子代理:** `extensions/subagents/agents/researcher.md` 和 `scout.md`

### 相关 wiki 文件（cubox 项目）
- `wiki/entities/agent-browser-runtime.md`
- `wiki/SCHEMA.md`
- `AGENTS.md`

---

## 2. 识别到的摩擦点（按严重程度排序）

### [高] F1: 无结构化仓库元数据返回

**问题:** 当前 GitHub 提取器将所有输出格式化为 Markdown 文本（`FetchResult.content: string`）。仓库元数据通过 `gh repo view` 或 REST API 获取，但被打包为一个不可分割的文本块。

**后果:**
- 研究 agent 无法通过编程方式提取结构化字段（stars、forks、license、topics）
- Wiki 实体创建必须手动重写这些实体到 YAML frontmatter
- 无法对仓库元数据做下游处理（排序、过滤、趋势分析）

**改进建议:**
- 为仓库元数据添加 `--json` 输出模式：`pi-wf --json https://github.com/owner/repo`
- 或添加专门的 `github_repo_info` 工具返回 JSON 元数据

### [高] F2: 无目录树/文件列表支持

**问题:** GitHub 提取器匹配四种 URL 模式（blob / repo根目录 / issues / pulls）。任何匹配 `/tree/` 的 URL 都会回退到通用管道，从 api.github.com 获取 HTML 页面而非结构化目录列表。

**后果:**
- Agent 无法从 GitHub 获取项目文件树（除非使用独立的 `gh api` 调用）
- 理解仓库架构需要手动克隆或使用浏览器
- 这是深度研究最大的单点摩擦——agent 在不知道结构的情况下盲目探索文件

**改进建议:**
- 在 `github.ts` 中添加 `tree` 匹配器和提取器
- 调 `gh api repos/owner/repo/git/trees/main?recursive=1` 获取文件树

### [高] F3: 速率限制对 agent 不可见

**问题:** `github.ts` 中的 `ghAvailable` 在会话启动时检查一次，并在进程存活期间缓存。Agent 在工具调用输出中看不到走的是 `gh` CLI（5000/hr）还是匿名 REST（60/hr）。

**后果:**
- 深度研究期间 agent 可能不知不觉达到 60/hr 匿名限制
- 获取失败时没有明确的限流指示
- `RESERVED_TOP` 过滤器只防明显错误路径，不防合法的 404

**改进建议:**
- 在提取器输出中加一行：`> Auth: gh CLI (5000/hr)` 或 `> Auth: anonymous (60/hr — 21 remaining)`
- 可选：剩余配额 < 10 时显示警告

### [中] F4: 无并行/批量 GitHub 内容获取

**问题:** pi-wf 的 web_fetch 工具每次调用处理一个 URL。没有批处理或并发概念。

**后果:**
- 读 20+ 个关键文件需要 20+ 轮对话
- 没有"给我这个目录中的所有源文件"的语义

**改进建议:**
- 在 `github.ts` 中添加 `batch` 模式，接收多个文件路径并行提取
- 或添加 `pi-wf --batch <file>` 模式

### [中] F5: 研究到 wiki ingest 的割裂

**问题:** 从 "pi-wf 获取 GitHub 数据" → "agent 综合信息" → "wiki 实体创建" 的管道每次都是全手动。

**后果:**
- 重复手工劳动（填 frontmatter、加来源链接、更新 index.md）
- wiki 实体质量和结构在不同研究之间不一致

**改进建议:**
- 添加 `wiki_ingest_github` 工具，用仓库元数据自动填充 OKF frontmatter
- 使用模板系统使实体页面结构一致

### [中] F6: GitHub 提交/发布/贡献者/活动未覆盖

**问题:** `github.ts` 正则只覆盖四种模式。缺失：
- `/owner/repo/releases` — 发布日志
- `/owner/repo/commits/main` — 提交历史
- `/owner/repo/graphs/contributors` — 贡献者
- `/owner/repo/network/dependencies` — 依赖关系

**后果:**
- 深度研究需要仓库活动、更新频率、贡献者生态信息时 agent 需手动搜索
- "这个仓库还在活跃维护吗？"难以确定

**改进建议:**
- 添加 `COMMITS_RE`、`RELEASES_RE` 匹配器
- 在仓库根目录输出中追加最近提交/发布活动摘要

### [低] F7: 无代码图谱/依赖关系可视化

**问题:** 理解导入图和文件间依赖关系是架构分析的关键，pi-wf 无内置支持。

**后果:**
- 架构分析依赖 agent 手动跟踪导入
- 大型仓库上下文可能装不下完整代码图

**改进建议:**
- 添加递归 git tree API 端点用于快速源码树
- 添加 `import_graph` 工具解析单语言 import/require 语句

---

## 3. 可以从 ABR（agent-browser-runtime）借鉴的模式

| ABR 特性 | pi-wf 是否缺失 | 相关性 |
|---|---|---|
| 提取器 JSON Schema 参数验证 | 部分缺失。`extract()` 接收 `(ctx, parsedUrl)` 无 schema 验证 | 低 |
| 重试机制 | **缺失**。pi-wf 在提取器间回退，但提取器内部无重试 | 中 |
| Artifact 管理 | 部分存在。有 `storage.ts` 处理截断，无正式工件系统 | 低 |
| Session Probe（轻量登录/可用性检查） | **缺失**。缓存一次 `ghAvailable`，无健康检查 | 中 |
| 平台冷却策略 | **缺失**。GitHub 不需要但其他来源有用 | 低 |
| 真实 UI 交互（CDP 键入+点击） | 部分存在。Playwright 用 `launchPersistentContext` 但仍用 `.goto()` | 低（GitHub 不需要） |
| 共享可见浏览器运行时 | 不在范围内 | 低 |
| 简洁提取器接口（export schema + extract） | 相似。pi-wf 的 `match()` + `extract()` 已做好关注分离 | N/A |

**最值得借鉴的 ABR 模式:**
1. 研究前轻量 session/health probe 验证 API 可用性 + 速率状态
2. 提取器间重试逻辑，指数退避处理 GitHub 临时错误

---

## 4. pi-wf 应保留的独特优势

| 优势 | 描述 |
|------|------|
| `gh CLI` 优先，匿名回退 | 认证 5000/hr → 匿名 60/hr 自动降级 |
| 丰富的领域提取器 | issue/PR 评论结构化提取（扁平 API → 格式化 Markdown 线程） |
| 30KB 截断 + 检索 | 大文件截断，完整版可通过 `retrieve` 获取 |
| 简单机制 + 智能诊断 | `ECONNREFUSED` → "Clash is down?"，`ENOTFOUND` → "DNS failed" |
| Defuddle 默认 | Pandoc 脚注 + schema.org 元数据 + 完整章节结构 |
| 跨子代理共享工具 | `researcher` / `scout` 子代理均可使用 `web_fetch` + `web_search` |
| Playwright + CloakBrowser 回退 | 反检测浏览器引擎处理反爬站点 |

---

## 5. 建议改进优先级

| 优先级 | 摩擦点 | 建议 | 工作量估算 |
|---|---|---|---|
| P0 | F2: 无目录树 | 添加 `tree` 模式到 `github.ts` | ~30 行 |
| P0 | F3: 速率限制不可见 | FetchResult 中追加认证模式行 | ~5 行 |
| P1 | F4: 无批量获取 | `github.ts` 添加 `batch` 模式 | ~80 行 |
| P1 | F1: 无结构化元数据 | `--json` 输出仓库元数据 | ~30 行 + wiki 模板 |
| P2 | F6: 提交/发布缺失 | 添加 `COMMITS_RE` + `gh api repos/X/releases/latest` | ~40 行 |
| P2 | F5: wiki ingest 割裂 | 添加 `wiki_ingest_github` 工具 | ~100 行 + wiki skill |
| P3 | F7: 代码图谱 | 添加 `source_tree` 工具 | ~60 行 |

---

## 6. 结论

pi-wf 在**从单个已知 URL 获取结构化 GitHub 内容**方面表现出色（PR、issue、单文件），但在**探索性架构分析**方面存在不足（列举文件、理解结构、研究级批量获取）。根本问题是：所有这些能力仅暴露给 LLM agent，但 agent 必须手动编排——没有"深度研究一个 GitHub 项目"的高级抽象。

ABR 的共享浏览器运行时模式对 pi-wf 单用户 CLI 过重，但其 **session probe** 和**提取器重试**模式可以低成本适配。最有影响力的改进是弥补"获取"和"代码库探索"之间的差距——不需要外部服务，只需在 `github.ts` 中扩展几个端点。

---

生成时间: 2026-06-24
研究工具: Claude Code via Happy
