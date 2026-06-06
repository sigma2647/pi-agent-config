# pi-wf / pi-ws smoke 测试命令 — 设计说明

**Date:** 2026-06-07
**Status:** 设计已批准，待实现
**Topic:** 给 `pi-wf` 和 `pi-ws` 加快速冒烟自检命令

---

## 1. 背景与动机

当前 `pi-agent-config` 的自检/测试覆盖有两层：

| 工具 | 用途 | 位置 |
|------|------|------|
| `pi-wf --doctor` / `pi-ws --doctor` | 环境/依赖体检（Node 版本、proxy 端口、API key、Playwright profile、chain 配置等） | `extensions/<tool>/tools/doctor.ts` |
| `tests/stress.sh` | 回归（覆盖每个 extractor + 并发 + 边界），~30s+ | `extensions/web-fetch/tests/stress.sh`（web-search 无对等物） |

**缺口：** `doctor` 只查"环境对不对"，**不验证「实际能不能工作」**；`stress.sh` ≥ 30s，不适合换机器 / 装完依赖 / 改完代码后随手跑一下。

本设计填补中间层：**5-15s 内的快速端到端冒烟**，每个工具几个最关键 case，确认基础功能没死。

## 2. 目标 / 非目标

**目标：**
- 加 `pi-wf --smoke` 和 `pi-ws --smoke` 两个 CLI flag
- 全程 ≤ 15s
- 真实网络，子进程 spawn 已安装的 `pi-wf` / `pi-ws` 做端到端测试
- 退出码 0/1 可直接被 shell / CI 消费
- 与现有 `--doctor` 共享底层 helpers（ANSI 颜色、`which`、`probeTcp`），不在两份代码里重复定义

**非目标：**
- 替代 `tests/stress.sh`——stress 仍负责覆盖每个 extractor、并发、边界
- 替代 `--doctor`——环境诊断仍是 doctor 的事；smoke 假定环境合规
- Monitor / heartbeat 用途：本期不加 `--json`，不为 cron 优化
- Fixture / 离线模式：smoke 用真实网络

## 3. 文件布局

```
extensions/web-fetch/tools/
├── doctor.ts          (现有，重构：import 共享 helpers)
├── smoke.ts           (新)
└── cli-helpers.ts     (新，从 doctor.ts 抽出)

extensions/web-search/tools/
├── doctor.ts          (现有，重构：import 共享 helpers)
├── smoke.ts           (新)
└── cli-helpers.ts     (新，从 doctor.ts 抽出)
```

**`cli-helpers.ts` 导出：**

```ts
export const OK: string;     // "\x1b[32m✓\x1b[0m" 或 "" (non-TTY)
export const BAD: string;    // "\x1b[31m✗\x1b[0m" 或 ""
export const WARN: string;   // "\x1b[33m!\x1b[0m" 或 ""
export const GREEN: string;  // "\x1b[32m" 或 ""
export const RED: string;    // "\x1b[31m" 或 ""
export const YELLOW: string; // "\x1b[33m" 或 ""
export const CYAN: string;   // "\x1b[36m" 或 ""
export const NC: string;     // "\x1b[0m" 或 ""

export function which(cmd: string): Promise<string | null>;
export function probeTcp(host: string, port: number, timeoutMs?: number): Promise<boolean>;
```

颜色常量在 module 初始化时按 `process.stdout.isTTY` 决定填值或空串。

**doctor.ts 重构：** 把 `OK` / `BAD` / `WARN` / `which` / `probeTcp` 的内联定义改成从 `./cli-helpers.ts` import。doctor 行为不变。

**为什么不跨扩展共享：** 跨目录相对 import 在 pi 加载器和独立 CLI 两个消费路径下都得手动调路径，麻烦不值；两份 ~25 行常量，颜色码和 TCP 探测函数不会变。AGENTS.md §1 关心的是「必须同步变化」的耦合——这里不存在。

## 4. CLI dispatch

`dev.ts` 顶层加 flag 解析（与现有 `--doctor` 同模式）：

```ts
if (args.includes("--smoke")) {
  const { runSmoke } = await import("./tools/smoke.ts");
  process.exit(await runSmoke());
}
```

`runSmoke()` 签名：`() => Promise<number>`，返回 `0` 或 `1`。

## 5. 测试用例

### 5.1 pi-wf — 3 cases

| ID | URL | 覆盖路径 | 断言 |
|----|-----|---------|------|
| `wiki-defuddle` | `https://en.wikipedia.org/wiki/HTTP` | Defuddle 主路径（default primary extractor） | exit=0 ∧ 输出 > 2048 B ∧ 含 `Hypertext Transfer` |
| `github-readme` | `https://github.com/anthropics/claude-code` | github domain extractor (`extractors/github.ts`) | exit=0 ∧ 输出 > 500 B ∧ 含 `anthropics/claude-code` |
| `hn-item` | `https://news.ycombinator.com/item?id=39000000` | hackernews domain extractor (`extractors/hackernews.ts`)，含嵌套评论结构 | exit=0 ∧ 输出 > 200 B ∧ 含 `HN item` |

**不覆盖（理由）：**
- PDF 路径：PDF 体量数 MB~10+ MB，超出 smoke 时间预算
- Playwright 路径：依赖 `~/.pw-capture-profile`，环境不稳
- wechat 路径：wechat URL 长期失效率高
- Jina fallback 路径：触发要让前两层都失败，构造稳定不易

以上保留给 `stress.sh phase1`。

### 5.2 pi-ws — 2 cases

| ID | 调用 | 覆盖路径 | 断言 |
|----|------|---------|------|
| `default-chain` | `pi-ws "wikipedia HTTP RFC"` | 默认链 `brave → opencli → browser` 命中首个非空 | exit=0 ∧ stdout 解析为合法 JSON ∧ `ok === true` ∧ `results.length >= 3` |
| `force-opencli` | `pi-ws --chain opencli "wikipedia HTTP RFC"` | 强制 opencli backend | 同上；`which opencli` 为 null → **SKIP**（不算 FAIL） |

**case 2 故意挑 opencli 而非 browser：** browser backend 需要 Chrome 9222 起 CDP，普通环境未必开；opencli 大概率装了。case 2 的目的是在「Brave 正常」时也验证 fallback 真能走通。

**查询词 `"wikipedia HTTP RFC"` 选择依据：** 三个高频技术词，所有通用搜索引擎都稳定返回 Wikipedia / IETF / MDN 链接，可稳定预期 ≥ 3 条结果。

## 6. 输出格式

人类可读 only（本期不加 `--json`）：

```
pi-wf smoke:
  PASS  wiki-defuddle       3245B   1.2s
  PASS  github-readme       2891B   0.8s
  PASS  hn-item              847B   0.4s

  pass=3  fail=0  skip=0  wall=2.4s
```

- 颜色：PASS 绿 / FAIL 红 / WARN+SKIP 黄
- Non-TTY（pipe、CI、`process.stdout.isTTY === false`）自动去色
- FAIL 时把对应 case 的 stderr 头 2 行缩进 echo 出来（沿用 stress.sh `head -2 | sed 's/^/        | /'` 风格）
- 末尾追加 Hint：`Hint: run pi-wf --doctor to triage env`，仅在 `fail > 0` 时打印

## 7. 退出码 & 超时

| exit | 含义 |
|------|------|
| 0 | 所有非 SKIP 案例 PASS |
| 1 | 至少 1 案例 FAIL（含超时） |

- **每案例超时：15s**（`execFile` 的 `timeout` 选项）
- **全程上限：30s**（用一个全局 timer 包住整个 `runSmoke()`；超时后剩余案例不再执行、计 FAIL）
- 案例**顺序执行**，不并发——并发只省 1-3 s 不值，chain 抖动叠加会造成 flaky

## 8. Preflight & SKIP 规则

- **smoke 不重做 doctor 的检查**：环境诊断的事让用户跑 `--doctor`
- **SKIP 仅在「该案例所需硬依赖明确缺失」时触发**：
  - pi-ws case 2：检查 `which opencli`，缺即 SKIP
  - pi-wf 三 case 不依赖外部 CLI，不 SKIP
- **不为「BRAVE_SEARCH_API_KEY 没设」做特殊 SKIP**：默认链有 fallback，case 1 走得通就 OK；走不通就让它 FAIL，提示去看 doctor

## 9. 实现细节 & 边界

- **找 `pi-wf` / `pi-ws` 命令的位置：** 从 PATH 解析（依赖 `extensions/install.sh` 已创建好的 `~/.local/bin` 链接）；找不到则 smoke 立即报错退出 1 + 提示 `extensions/install.sh`
- **环境变量直通：** smoke.ts 不操心 `HTTP_PROXY` / `BRAVE_SEARCH_API_KEY`，子进程继承当前 shell env
- **断言失败时的诊断信息格式：** 每个 case 单条 PASS/FAIL 行；FAIL 时附 reason：`exit=N` / `size=NB < min=MB` / `pattern not found: <regex>` / `timeout after 15s`
- **JSON 断言（pi-ws）：** `try { JSON.parse(stdout) }` 失败 → reason `not valid JSON`；`ok !== true` → reason `ok=false`；`results.length < N` → reason `results=N < min=M`

## 10. 未来扩展点（不在本期范围）

- `--json` 输出：将来要 monitor 用时再加
- `pi-health` 包装 binary：跨工具汇总，若 smoke 用熟后发现需要再加
- Fixture / VCR 模式：网络不稳时回放，目前不需要

## 11. 验收清单（实现完成的标志）

1. `pi-wf --smoke` 在 PASS 路径 ≤ 5s 返回 exit 0，输出表格如 §6
2. `pi-ws --smoke` 在 PASS 路径 ≤ 8s 返回 exit 0
3. `pi-wf --smoke` 任一案例 FAIL → exit 1，包含 stderr 摘录和 doctor hint
4. `pi-ws --smoke` 无 opencli 时 case 2 显示 SKIP，不影响 exit code
5. 两个 `doctor.ts` 重构后行为与重构前**完全一致**（颜色、布局、字段不变）
6. 两份 `cli-helpers.ts` 文件头都带注释 `// Mirror of extensions/<other>/tools/cli-helpers.ts — keep in sync.`，内容字节级相同（可 `diff` 验证）
7. Non-TTY 调用（`pi-wf --smoke | cat`）输出无 ANSI 转义
