# web-search 重构设计

- **日期**：2026-05-20
- **作者**：lorence.xing@gmail.com（与 Claude 协作）
- **状态**：待审阅
- **影响范围**：`~/.pi/agent/extensions/web-search/`

## 1. 背景与动机

当前 `index.ts` 只用 DuckDuckGo（一路 Instant Answer API + 一路 HTML 抓取）。问题：

- DDG 结果稀疏，HTML 正则容易随版本飘
- 无回退，单点失败整个 `web_search` 工具失效
- 单文件混杂注册逻辑与具体抓取逻辑，新加搜索源要改主体

目标：把搜索源做成**可插拔、可重排序、能快速失败**的回退链。

## 2. 目标 / 非目标

**目标**
- 把搜索源解耦为多个 backend，可独立增删
- 提供运行时可配置的回退链（环境变量 + 单次调用覆盖）
- 整链最坏延迟可控（默认 ≤ 15s）
- 空结果立即下钻到下一层，不空等超时
- 输出格式统一，工具调用方（LLM / `/search` 命令）无感

**非目标**
- 不做缓存层（YAGNI；上游 pi 会话本身有上下文）
- 不做并发竞速 race 模式（用户选 sequential；后续可加）
- 不保留 DDG instant/HTML（用户未选；删除）
- 不做结果去重 / 排序融合（用户没要求）

## 3. 架构

### 3.1 目录结构

```
web-search/
├── index.ts            # 注册 web_search 工具 + /search 命令；串联回退链
├── chain.ts            # runChain(query, opts) — 依序尝试，首个非空成功即返
├── config.ts           # 读环境变量，解析 chain / timeout / browser backend
├── validate.ts         # 关键词验证（query token vs result title+snippet）
└── backends/
    ├── types.ts        # SearchResult, Backend 接口
    ├── brave.ts        # Brave Search API
    ├── opencli.ts      # spawn `opencli google search <q> -f json`
    └── browser.ts      # 运行时探测 browser-harness / playwright，二选一
```

**先用多文件方案**。如果 pi 扩展加载器不支持相对 import（实施时验证），降级为单文件 + 函数化拆分。

### 3.2 核心契约

```ts
// backends/types.ts
export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export interface Backend {
  name: string;                                          // "brave" | "opencli" | "browser"
  isAvailable(): Promise<boolean>;                       // 检查 env/CLI/依赖
  search(query: string, signal: AbortSignal): Promise<SearchResult[]>;
}
```

所有 backend 输出统一 `SearchResult[]`。`isAvailable === false` → 跳过，零成本。

### 3.3 回退链行为

默认链：`brave → opencli → browser`

判定逻辑（每一层）：
1. `isAvailable()` 为 false → 跳过，记 SKIPPED
2. 在该 backend 的超时内调 `search()`
3. 抛错 → 记 FAILED，进下一层
4. 返回数组但被关键词验证过滤后 < 1 条 → 记 EMPTY，进下一层
5. 返回 ≥ 1 条通过验证的结果 → 成功，立即返回

全部失败 → 抛聚合错误，附每层 SKIPPED/FAILED/EMPTY 的原因。

### 3.4 超时

| 层 | 默认 | 覆盖 env |
|---|---|---|
| brave | 4000 ms | `PI_WEB_SEARCH_TIMEOUT_BRAVE` |
| opencli | 6000 ms | `PI_WEB_SEARCH_TIMEOUT_OPENCLI` |
| browser | 10000 ms | `PI_WEB_SEARCH_TIMEOUT_BROWSER` |
| 整链总预算 | 15000 ms | `PI_WEB_SEARCH_TOTAL_TIMEOUT` |

整链总预算是兜底：即使每层都没单独超时，累计达此值整链 abort。

### 3.4a 代理 + CDP 配置（v1.1 追加）

**Brave HTTP 代理：**
- 读取顺序：`PI_WEB_SEARCH_PROXY` → `HTTPS_PROXY/https_proxy` → `HTTP_PROXY/http_proxy` → `ALL_PROXY/all_proxy`
- pi 运行时优先 `undici.ProxyAgent`（pi 自带 undici）；undici 不可达时回退到 Node 24+ 原生 `fetch` 的 `NODE_USE_ENV_PROXY=1` 行为
- 单独跑 tsx 没装 undici 时，要么 `npm i undici`，要么用 `NODE_USE_ENV_PROXY=1` 启动

**Browser CDP：**
- 新 env `PI_WEB_SEARCH_CDP_URL`（默认 `http://127.0.0.1:9222`）
- `PI_WEB_SEARCH_BROWSER_BACKEND` 取值：
  - `auto`（默认）：先探测 `PI_WEB_SEARCH_CDP_URL/json/version` 可达 + playwright 可 import → 选 playwright；否则 → 选 harness（若装了）；都没有 → unavailable
  - `playwright`：强制走 CDP，依赖远端调试端口可达 + playwright 可解析
  - `harness`：强制 browser-harness
- Playwright 解析顺序：`import("playwright")` → `import("playwright-core")` → 几个常见全局 npm 路径 → `createRequire` 兜底

### 3.5 关键词验证

每条结果用 query 关键词过滤，避免"垃圾成功"：

```ts
// validate.ts
function isRelevant(query: string, r: SearchResult): boolean {
  const tokens = extractTokens(query);
  if (tokens.length === 0) return true;                  // query 全是符号/空 → 不过滤
  const hay = (r.title + " " + r.snippet).toLowerCase();
  return tokens.some(t => hay.includes(t));              // 至少匹配一个 token
}
```

`extractTokens`：
- 小写、去标点、按空白和常见分隔切
- 丢弃 < 2 字符 token 和英文停用词（a/the/and/or/of/in/to/for/is）
- CJK 不做分词：原始 query 中的中文整体作为一个 token

边界：query 是 `"foo"` → token = `["foo"]` → 没有任何结果含 "foo" 时整层判 EMPTY，进下一层。

### 3.6 配置优先级（从高到低）

1. **运行时参数**：`web_search({ query, chain: ["opencli","brave"] })`
   - 允许 LLM / 命令行覆盖，但只能用已注册的 backend 名
   - 未注册的名字 → silently skip + warning（不报错）
2. **环境变量**：`PI_WEB_SEARCH_CHAIN="brave,opencli,browser"`
3. **代码默认值**：`["brave", "opencli", "browser"]`

### 3.7 Backend 注册机制

`index.ts` 集中注册：

```ts
import { registerBackend, runChain } from "./chain";
import { braveBackend } from "./backends/brave";
import { opencliBackend } from "./backends/opencli";
import { browserBackend } from "./backends/browser";

registerBackend(braveBackend);
registerBackend(opencliBackend);
registerBackend(browserBackend);
```

加新后端（例如 Bing、Tavily、SearXNG）只需：
1. 新建 `backends/bing.ts`，实现 `Backend` 接口
2. `index.ts` 加一行 `registerBackend(bingBackend)`
3. （可选）改默认 `PI_WEB_SEARCH_CHAIN` 把它纳入链

## 4. 各 Backend 细节

### 4.1 brave.ts

- `isAvailable()` → 检查 `BRAVE_SEARCH_API_KEY` 环境变量
- API: `GET https://api.search.brave.com/res/v1/web/search?q=<q>&count=10`
- Header: `X-Subscription-Token: <key>`, `Accept: application/json`
- 解析：`data.web.results[].{title, url, description}` → `SearchResult`
- 失败码：4xx/5xx 直接抛错（不重试）

### 4.2 opencli.ts

- `isAvailable()` → `which opencli` && `opencli doctor` 退出码 = 0
- 命令：`opencli google search "<query>" -f json`
- 用 `child_process.spawn`，stdio 抓 stdout，遵守 AbortSignal（signal abort → kill 子进程）
- 解析 JSON：opencli 输出格式实施时确认（先跑一遍真实命令拿样例）
- 失败：exit code ≠ 0 → 抛错；stdout 非 JSON → 抛错

### 4.3 browser.ts

运行时探测两个实现，按以下顺序：

1. `which browser-harness` 成功 → 用 browser-harness（subprocess 跑 Python heredoc）
2. `require.resolve("playwright")` 成功 → 用 playwright（Node 直接调）
3. 都没有 → `isAvailable()` 返回 false

可用 `PI_WEB_SEARCH_BROWSER_BACKEND=harness|playwright|auto` 强制。默认 `auto`。

具体目标站：默认 `https://www.google.com/search?q=<q>`。选择器随 Google 改版易飘 — **此模块允许失败**，作为最后兜底有几率成功就行。

参考：
- browser-harness CLI 调用样式：`browser-harness <<'PY' ... PY`，helpers 已预导入（`new_tab`、`page_info`、`screenshot`、`js`）
- 参见 `/home/lawrence/Developer/browser-harness/helpers.py` 与 `/home/lawrence/Developer/browser-harness/domain-skills/`

## 5. 工具 / 命令接口

### 5.1 `web_search` 工具

参数：

```ts
{
  query: string,
  mode?: "instant" | "full",          // 旧参数兼容，重新映射
  chain?: string[],                   // 新增，运行时覆盖回退链
}
```

`mode` 重映射：
- `"instant"` → 只跑链中**第一个可用** backend，拿到任意结果就返回（短路）
- `"full"`（默认）→ 完整链直到首个非空成功

### 5.2 `/search` 命令

`/search <query>` — 与 `mode: "full"` 等价。命令模式不暴露 `chain` 覆盖（复杂度不值）。

### 5.3 输出格式

成功：
```
[backend: brave] (5 results)

1. **Title**
   https://url
   snippet ...

2. ...
```

完全失败：
```
Web search failed for "foo". Backends tried:
  - brave: SKIPPED (no BRAVE_SEARCH_API_KEY)
  - opencli: FAILED (BROWSER_CONNECT)
  - browser: EMPTY (0 results matched query keywords)

Hint: set BRAVE_SEARCH_API_KEY, or start opencli Browser Bridge.
```

## 6. 取消与错误处理

- 所有 backend 必须接受 `AbortSignal` 并在 abort 时立即清理（关 fetch / kill 子进程）
- `ctx.signal`（pi 提供）→ 顶层 abort
- 每层超时 → `AbortController` 派生子 signal
- 总预算超时 → 顶层 abort
- 一层失败不污染下一层；最终聚合错误展示所有层状态

## 7. 兼容性与迁移

- 删除 `searchDDG` / `searchDDGHTML`
- `prepareArguments` 保留：`q` → `query`，无 `mode` → 默认 `"full"`，再加：未知 backend 名从 `chain` 数组里过滤掉 + warning
- `session_start` 启动提示保留，加一行显示当前生效的 chain

## 8. 测试策略

实施阶段需要的最小验证（不写正式测试套件 — pi 扩展场景偏脚本化）：

1. **手动 smoke**：分别在以下条件下跑 `/search rust async tutorial`
   - 设了 BRAVE_SEARCH_API_KEY → 应走 brave
   - 没设 key，opencli daemon 在跑 → 应走 opencli
   - 都没有，browser-harness 在 → 应走 browser
   - 全没有 → 应得到聚合错误
2. **关键词验证**：跑 `/search asdfqwerzxcv1234`（保证 0 命中）→ 整链应判 EMPTY 并尽快返回
3. **取消**：跑慢查询同时按 Ctrl-C → 应立即停（不挂住）

## 9. 实施顺序（建议给 writing-plans）

1. 抽 `backends/types.ts` 接口 + `chain.ts` 串行器（先不接 backend，跑空链单测一遍）
2. 实现 `backends/brave.ts`（最简单，只是 HTTP）
3. 实现 `backends/opencli.ts`（先手动跑 `opencli google search` 确认 JSON 结构）
4. 实现 `backends/browser.ts`（先只支持 browser-harness 路径，playwright 路径作为 v2）
5. 接入 `index.ts`，连通 `web_search` 工具与 `/search` 命令
6. 删除旧 DDG 代码
7. 手动 smoke 测全链路

## 10. 风险与未决项

| 项 | 风险 | 缓解 |
|---|---|---|
| pi 扩展加载器对相对 import 的支持 | 多文件方案不可行 | 实施第 1 步先验证；不行就降级为单文件 |
| opencli JSON schema | 没文档，靠样例反推 | 实施前手动跑一次 `opencli google search "test" -f json` 抓样例 |
| browser-harness 调用方式 | 跨进程 + Python 堆叠，错误链长 | 这层"允许失败"，超时短，影响可控 |
| Brave API 速率限制 | 免费层 1 req/s | 不重试，命中限速直接报错进下一层 |
| 关键词验证误杀 | 同义词 / 翻译类查询可能全不含 token | token = 0 时不过滤；非英语 query 整段作为 token，匹配较宽松 |
