# extensions/subagents/ 吸收优化分析

**日期:** 2026-07-03
**对比源:**
- `/home/lawrence/repo/repo-llm/pi-subagents` (同步 JSON-mode，同架构参考)
- `/home/lawrence/repo/repo-llm/pi-interactive-subagents` (mux-based async，异架构参考)

---

## 三坐标对比

| 维度 | 你的 subagents | pi-subagents | pi-interactive-subagents |
|------|---------------|-------------|--------------------------|
| 架构 | 同步 spawn pi JSON | 同步 spawn pi JSON | 异步 fire-and-forget mux pane |
| 执行模型 | 阻塞等待结果 | 阻塞等待结果 | 立即返回，steer 回传结果 |
| TUI widget | ❌ | ❌ | ✅ live widget above input |
| Markdown 渲染 | ❌ (plain Text) | ✅ `Markdown` 组件 | ✅ `Box` 背景色 |
| 工具预览 | 通用 JSON dump | 按工具类型格式化 | 单行摘要 |
| 结果背景色 | ❌ | ❌ | ✅ 成功绿/失败红背景 |
| 边框装饰 | ❌ | ❌ | ✅ `╭─╮││╰─╯` 边框 |
| 耗时格式 | `1m23s` | `1m23s` | `01:23` (MM:SS) |
| 状态监督 | ❌ | ❌ | ✅ active/waiting/stalled |
| agent 发现 | agents/*.md only | agents/*.md only | project/global/bundled 三层 |
| 中断/恢复 | ❌ | ❌ | ✅ interrupt/resume |
| Session lineage | ❌ | ❌ | ✅ standalone/lineage-only/fork |

---

## 可直接吸收的改进（同架构，低风险）

### 1. ⭐ Markdown 渲染展开结果 — 从 pi-subagents

当前 `renderAgentProgress` 在展开时用 `Text` 渲染最终输出。pi-subagents 用 `getMarkdownTheme()` + `Markdown` 组件，LLM 产出的 markdown 列表、代码块、链接都能正确渲染。

**位置：** `index.ts` 中 `renderAgentProgress` 函数，`r.output` 展开渲染那一段。

```typescript
// 当前 (plain Text):
c.addChild(new Text(theme.fg("text", r.output), 0, 0));

// 改进后 (Markdown 组件):
const mdTheme = getMarkdownTheme();
c.addChild(new Markdown(r.output, 0, 0, mdTheme));
```

### 2. ⭐ 按工具类型格式化预览 — 从 pi-subagents

pi-subagents 的 `formatToolPreview()` 对每种工具做特定格式化：

```
bash/safe_bash → $ <command>
read          → read path.ts
web_search    → search "query"
web_fetch     → fetch url
```

当前 `extractToolArgsPreview()` 是通用 `JSON.stringify` dump，可读性差。

### 3. ⭐ 用 pi-coding-agent 的 parseFrontmatter — 从 pi-subagents

当前手写了最小 frontmatter parser（~20 行），pi-subagents 直接从 `@mariozechner/pi-coding-agent` import `parseFrontmatter`。`@earendil-works/pi-coding-agent` 也 export 了同名函数，可以直接用——删 20 行，加 1 行 import。

### 4. ⭐ 结果框背景色 — 从 pi-interactive-subagents 的灵感

pi-interactive-subagents 为完成/失败结果加了彩色背景 Box：

```typescript
// 成功
new Box(1, 1, (text) => theme.bg("toolSuccessBg", text))
// 失败
new Box(1, 1, (text) => theme.bg("toolErrorBg", text))
```

当前 `renderResult` 直接返回 `Container` → `renderAgentProgress`，没有背景色区分。

### 5. MM:SS 耗时格式

`formatDuration` 当前输出 `1m23s`，pi-interactive-subagents 用 `00:23` / `01:23`。更紧凑。

---

## 中优先级（需设计决策）

### 6. 边框容器包装结果

pi-interactive-subagents 的结果有 `╭─╮││╰─╯` 边框。对 JSON-mode subagent 来说，这个包装可以让结果块在终端中更显眼。`@mariozechner/pi-tui` 有 `Box`，可以直接用。

### 7. Status 摘要标签

即使同步模式下没有 `active/waiting/stalled` 状态流，也可以在 agent header 行加一个简短的状态词（`running…` / `completed`），和 pi-interactive-subagents 的 widget label 风格一致。

---

## 图标修改建议

当前图标方案：

```
⟳  running    (theme.fg("warning"))
○  pending    (theme.fg("dim"))
✓  completed  (theme.fg("success"))
✗  failed     (theme.fg("error"))
▸  active tool
```

**评价：已经很好。** 这些 Unicode 字符兼容所有终端字体，不需要 Nerd Font。

唯一可微调的：

| 当前 | 可选替代 | 理由 |
|------|---------|------|
| `⟳` | `◌` / `◎` | `⟳` 在部分字体中可能显示为纯箭头 |
| `▸` | `▶` / `❯` | `▸` 已经很好，`❯` 更常见 |
| — | 加 `⬆`/`⬇` 给 usage line | 当前 `↑` `↓` 已够用 |

**建议：保持现状。** Unicode 图标方案已经很好，Nerd Font 图标（`󰄵` `󰅖` `󰑖`）要求用户装特定字体，不值得。

---

## 不应吸收的（架构不兼容）

- **mux-based async 模型** — 完全不同，等于重写
- **subagent_interrupt / subagent_resume** — 需要长期存活的 pane
- **Activity snapshots / stalled 检测** — 需要子进程写心跳文件
- **Session lineage (standalone/lineage-only/fork)** — 需要 session 文件 seeding
- **`/plan` `/iterate` `/subagent` 命令** — 绑定他们的 agent 体系（planner/reviewer）
- **Box widget above input** — 需要 pi 的 widget API
- **Planner / reviewer / visual-tester agents** — 场景不同

---

## 建议实施优先级

| 优先级 | 改进 | 来源 | 工作量 |
|--------|------|------|--------|
| **P0** | Markdown 渲染展开输出 | pi-subagents | ~5 行 |
| **P0** | 按工具类型格式化预览 | pi-subagents | ~30 行 |
| **P0** | 用上游 parseFrontmatter | pi-subagents | ~2 行（删 20 行） |
| **P1** | 成功/失败背景色 Box | interactive-subagents | ~15 行 |
| **P1** | MM:SS 耗时格式 | interactive-subagents | ~5 行 |
| **P2** | 边框容器包装结果 | interactive-subagents | ~20 行 |
| **P2** | Status 摘要标签 | interactive-subagents | ~5 行 |
