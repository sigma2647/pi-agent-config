# web-search 重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 pi 的 `web-search` 扩展从单文件 DDG 实现重构成可插拔的多 backend 回退链（Brave → opencli → browser-harness/playwright），紧超时 + 关键词验证，可由 env / 调用参数重排链。

**Architecture:** 多文件目录，`Backend` 接口统一契约。`chain.ts` 顺序跑链，整链总预算 15s 兜底。`index.ts` 只负责注册工具/命令和串联组件。

**Tech Stack:** TypeScript, `@earendil-works/pi-coding-agent` (jiti 加载，支持相对 import + ESM)，Node 内置 `fetch` / `child_process` / `AbortController`。

**Spec:** `/home/lawrence/.pi/agent/extensions/web-search/docs/2026-05-20-web-search-refactor-design.md`

**项目约束：**
- 此目录非 git 仓库 → 不写 `git commit` 步骤；改用文件备份做 checkpoint
- 没有单元测试框架 → 用 `pi -p` 命令行执行 + `tsc --noEmit`（若装了 TS）做验证
- 旧文件 `index.ts` 在第 0 步先备份成 `index.ts.bak`，全部完成后再删除

---

## 文件结构

```
web-search/
├── index.ts                       # 入口；只注册工具/命令 + 串联组件
├── chain.ts                       # runChain + registerBackend + 配置读取
├── validate.ts                    # 关键词验证
├── backends/
│   ├── types.ts                   # SearchResult, Backend 接口
│   ├── brave.ts                   # Brave Search API
│   ├── opencli.ts                 # spawn opencli google search
│   └── browser.ts                 # 探测 browser-harness / playwright
├── docs/
│   ├── 2026-05-20-web-search-refactor-design.md
│   └── 2026-05-20-web-search-refactor-plan.md
└── index.ts.bak                   # 旧实现的快照（流程末尾删除）
```

每个文件的职责：

| 文件 | 职责 | 不做的事 |
|---|---|---|
| `index.ts` | 注册 `web_search` 工具 + `/search` 命令；引导 chain | 不写任何 backend 抓取逻辑 |
| `chain.ts` | 全局 backend 注册表 + sequential runner + env 配置读取 | 不知道具体某个 backend 怎么实现 |
| `validate.ts` | `extractTokens(query)` + `isRelevant(query, result)` | 不读 env |
| `backends/types.ts` | `SearchResult` + `Backend` 接口 + `BackendStatus` 枚举 | 不实现任何 backend |
| `backends/brave.ts` | Brave Search API HTTP 调用 + 解析 | 不知道链怎么跑 |
| `backends/opencli.ts` | spawn opencli + 解析 JSON | 不知道链怎么跑 |
| `backends/browser.ts` | 探测 + 调 browser-harness（v1）/ playwright（v2） | 不知道链怎么跑 |

---

## Task 0: 备份现有实现 + 准备目录

**Files:**
- Backup: `~/.pi/agent/extensions/web-search/index.ts` → `index.ts.bak`
- Create: `~/.pi/agent/extensions/web-search/backends/` 目录

- [ ] **Step 1: 备份原 index.ts**

```bash
cp ~/.pi/agent/extensions/web-search/index.ts ~/.pi/agent/extensions/web-search/index.ts.bak
```

- [ ] **Step 2: 创建 backends 目录**

```bash
mkdir -p ~/.pi/agent/extensions/web-search/backends
```

- [ ] **Step 3: 验证文件结构**

```bash
ls ~/.pi/agent/extensions/web-search/
```

Expected: 包含 `index.ts`、`index.ts.bak`、`backends/`、`docs/`。

---

## Task 1: 定义类型接口（`backends/types.ts`）

**Files:**
- Create: `~/.pi/agent/extensions/web-search/backends/types.ts`

- [ ] **Step 1: 写 types.ts**

```typescript
// backends/types.ts

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type BackendStatus =
  | { kind: "ok"; results: SearchResult[] }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "empty"; reason: string };

export interface Backend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  search(query: string, signal: AbortSignal): Promise<SearchResult[]>;
}

export type BackendAttempt = {
  name: string;
  status: BackendStatus;
  elapsedMs: number;
};
```

- [ ] **Step 2: 用 jiti 解析这个文件 quick check**

```bash
cd ~/.pi/agent/extensions/web-search && node -e "import('./backends/types.ts').then(m => console.log('keys:', Object.keys(m)))" 2>&1 | head
```

Expected: 输出 `keys: []`（types 都是 type-only export，运行时无导出，这是对的）。

---

## Task 2: 关键词验证（`validate.ts`）

**Files:**
- Create: `~/.pi/agent/extensions/web-search/validate.ts`

- [ ] **Step 1: 写 validate.ts**

```typescript
// validate.ts

import type { SearchResult } from "./backends/types";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "to", "for", "is", "on",
  "at", "by", "with", "as", "be", "this", "that", "it", "are", "was",
  "were", "from", "but", "not", "you", "i", "we", "they",
]);

const CJK_RE = /[一-鿿぀-ゟ゠-ヿ]/;

export function extractTokens(query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];

  // CJK 整段查询：原始 query 整体作为单个 token（小写）
  if (CJK_RE.test(trimmed)) {
    return [trimmed];
  }

  const raw = trimmed
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));

  return [...new Set(raw)];
}

export function isRelevant(query: string, r: SearchResult): boolean {
  const tokens = extractTokens(query);
  if (tokens.length === 0) return true; // 全符号查询 → 不过滤
  const hay = `${r.title} ${r.snippet}`.toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

export function filterRelevant(
  query: string,
  results: SearchResult[],
): SearchResult[] {
  return results.filter((r) => isRelevant(query, r));
}
```

- [ ] **Step 2: 写一段临时 smoke 脚本验证 tokenization**

```bash
cd ~/.pi/agent/extensions/web-search && node --input-type=module -e "
import { extractTokens, isRelevant } from './validate.ts';
console.log('英文:', extractTokens('rust async tutorial'));
console.log('停用词:', extractTokens('how to be the best'));
console.log('CJK:', extractTokens('Python 教程'));
console.log('符号:', extractTokens('!!! ???'));
console.log('relevant T:', isRelevant('foo bar', {title: 'about Foo', url: '', snippet: ''}));
console.log('relevant F:', isRelevant('xyz123', {title: 'about cat', url: '', snippet: 'dog'}));
" 2>&1 | head -20
```

Expected：
```
英文: [ 'rust', 'async', 'tutorial' ]
停用词: [ 'how', 'best' ]
CJK: [ 'python 教程' ]
符号: []
relevant T: true
relevant F: false
```

如果 node 不支持 `.ts` 后缀直跑，用 `npx tsx -e ...` 或装 jiti：`node --import=jiti/register --input-type=module ...`。**如果都没装就跳过 Step 2，靠 Task 7 集成时验证。**

---

## Task 3: 配置 + Chain Runner（`chain.ts`）

**Files:**
- Create: `~/.pi/agent/extensions/web-search/chain.ts`

- [ ] **Step 1: 写 chain.ts**

```typescript
// chain.ts

import type { Backend, BackendAttempt, SearchResult } from "./backends/types";
import { filterRelevant } from "./validate";

const REGISTRY = new Map<string, Backend>();

export function registerBackend(b: Backend): void {
  REGISTRY.set(b.name, b);
}

export function listBackends(): string[] {
  return [...REGISTRY.keys()];
}

export type ChainConfig = {
  chain: string[];
  perBackendTimeoutMs: Record<string, number>;
  totalTimeoutMs: number;
};

const DEFAULT_TIMEOUTS: Record<string, number> = {
  brave: 4000,
  opencli: 6000,
  browser: 10000,
};

const DEFAULT_TOTAL_TIMEOUT_MS = 15000;
const DEFAULT_CHAIN = ["brave", "opencli", "browser"];

export function loadConfig(override?: {
  chain?: string[];
  totalTimeoutMs?: number;
}): ChainConfig {
  const envChain = process.env.PI_WEB_SEARCH_CHAIN
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const rawChain = override?.chain ?? envChain ?? DEFAULT_CHAIN;
  const knownChain = rawChain.filter((name) => {
    if (REGISTRY.has(name)) return true;
    // eslint-disable-next-line no-console
    console.warn(`[web-search] unknown backend "${name}" ignored`);
    return false;
  });

  const perBackendTimeoutMs: Record<string, number> = { ...DEFAULT_TIMEOUTS };
  for (const name of REGISTRY.keys()) {
    const envKey = `PI_WEB_SEARCH_TIMEOUT_${name.toUpperCase()}`;
    const raw = process.env[envKey];
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) perBackendTimeoutMs[name] = n;
    }
  }

  const totalEnv = Number(process.env.PI_WEB_SEARCH_TOTAL_TIMEOUT);
  const totalTimeoutMs =
    override?.totalTimeoutMs ??
    (Number.isFinite(totalEnv) && totalEnv > 0
      ? totalEnv
      : DEFAULT_TOTAL_TIMEOUT_MS);

  return { chain: knownChain, perBackendTimeoutMs, totalTimeoutMs };
}

export type ChainResult =
  | { kind: "ok"; backend: string; results: SearchResult[]; attempts: BackendAttempt[] }
  | { kind: "fail"; attempts: BackendAttempt[] };

export async function runChain(
  query: string,
  parentSignal: AbortSignal,
  opts?: { chain?: string[]; shortCircuit?: boolean },
): Promise<ChainResult> {
  const cfg = loadConfig({ chain: opts?.chain });
  const attempts: BackendAttempt[] = [];

  const totalCtl = new AbortController();
  const onParentAbort = () => totalCtl.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const totalTimer = setTimeout(
    () => totalCtl.abort(new Error("total timeout")),
    cfg.totalTimeoutMs,
  );

  try {
    for (const name of cfg.chain) {
      if (totalCtl.signal.aborted) break;

      const backend = REGISTRY.get(name);
      if (!backend) continue; // 已在 loadConfig warned

      const t0 = Date.now();

      const available = await backend.isAvailable().catch(() => false);
      if (!available) {
        attempts.push({
          name,
          status: { kind: "skipped", reason: "not available" },
          elapsedMs: Date.now() - t0,
        });
        continue;
      }

      const perTimeoutMs = cfg.perBackendTimeoutMs[name] ?? 8000;
      const perCtl = new AbortController();
      const fwd = () => perCtl.abort(totalCtl.signal.reason);
      totalCtl.signal.addEventListener("abort", fwd, { once: true });
      const perTimer = setTimeout(
        () => perCtl.abort(new Error(`${name} timeout`)),
        perTimeoutMs,
      );

      try {
        const raw = await backend.search(query, perCtl.signal);
        const filtered = filterRelevant(query, raw);
        const elapsedMs = Date.now() - t0;

        if (filtered.length === 0) {
          attempts.push({
            name,
            status: {
              kind: "empty",
              reason: `0 of ${raw.length} results matched query keywords`,
            },
            elapsedMs,
          });
          continue;
        }

        attempts.push({
          name,
          status: { kind: "ok", results: filtered },
          elapsedMs,
        });

        if (opts?.shortCircuit) {
          return { kind: "ok", backend: name, results: filtered, attempts };
        }
        return { kind: "ok", backend: name, results: filtered, attempts };
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : String(err);
        attempts.push({
          name,
          status: { kind: "failed", reason },
          elapsedMs: Date.now() - t0,
        });
      } finally {
        clearTimeout(perTimer);
        totalCtl.signal.removeEventListener("abort", fwd);
      }
    }
  } finally {
    clearTimeout(totalTimer);
    parentSignal.removeEventListener("abort", onParentAbort);
  }

  return { kind: "fail", attempts };
}
```

> **关于 `shortCircuit`：** 设计文档中 `mode: "instant"` 映射为"链中第一个可用 backend 出结果即返"。由于成功本来就立即返，参数当前没有差异；保留是为了将来若改 race 模式时语义存在。Task 7 把 `mode: "instant"` 直接映射成 `shortCircuit: true`。

- [ ] **Step 2: 临时单元化验证 chain runner 的骨架（registry 为空时即 fail）**

```bash
cd ~/.pi/agent/extensions/web-search && node --input-type=module -e "
import { runChain, registerBackend, listBackends } from './chain.ts';
const ctl = new AbortController();
const r = await runChain('test', ctl.signal);
console.log('empty chain result:', r.kind, 'attempts:', r.attempts.length);
console.log('registered:', listBackends());
" 2>&1 | head -10
```

Expected：
```
empty chain result: fail attempts: 0
registered: []
```

（无 backend 注册时 chain 空，立即返 fail；不报错。）

如果 `node` 不支持 `.ts`，参见 Task 2 的 Step 2 备注；跳过 Step 2，留到 Task 7 验证。

---

## Task 4: Brave Backend（`backends/brave.ts`）

**Files:**
- Create: `~/.pi/agent/extensions/web-search/backends/brave.ts`

- [ ] **Step 1: 写 brave.ts**

```typescript
// backends/brave.ts

import type { Backend, SearchResult } from "./types";

type BraveResponse = {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
};

export const braveBackend: Backend = {
  name: "brave",

  async isAvailable() {
    return !!process.env.BRAVE_SEARCH_API_KEY;
  },

  async search(query, signal) {
    const key = process.env.BRAVE_SEARCH_API_KEY;
    if (!key) throw new Error("BRAVE_SEARCH_API_KEY not set");

    const url =
      `https://api.search.brave.com/res/v1/web/search` +
      `?q=${encodeURIComponent(query)}&count=10`;

    const res = await fetch(url, {
      signal,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": key,
      },
    });

    if (!res.ok) {
      throw new Error(`brave HTTP ${res.status}`);
    }

    const data = (await res.json()) as BraveResponse;
    const raw = data.web?.results ?? [];
    const results: SearchResult[] = raw
      .filter((x) => x.title && x.url)
      .map((x) => ({
        title: x.title ?? "",
        url: x.url ?? "",
        snippet: x.description ?? "",
      }));

    return results;
  },
};
```

- [ ] **Step 2: 集成验证 — 注册 brave 跑一次（如果你有 key）**

```bash
cd ~/.pi/agent/extensions/web-search && BRAVE_SEARCH_API_KEY="$BRAVE_SEARCH_API_KEY" node --input-type=module -e "
import { registerBackend, runChain } from './chain.ts';
import { braveBackend } from './backends/brave.ts';
registerBackend(braveBackend);
const ctl = new AbortController();
const r = await runChain('rust async tutorial', ctl.signal);
console.log(JSON.stringify(r, null, 2).slice(0, 800));
" 2>&1 | head -40
```

Expected 有 key 时：`{ "kind": "ok", "backend": "brave", "results": [...] }`。
没 key 时：`{ "kind": "fail", "attempts": [{ name: "brave", status: { kind: "skipped" } }] }`。

---

## Task 5: opencli Backend（`backends/opencli.ts`）

**前置一次性手工动作（不写进 plan 步骤，但要记得）：**
确认 opencli 正常工作后，跑一次拿真实 JSON 样例：
```bash
opencli google search "anthropic claude" -f json | head -200 > /tmp/opencli-sample.json
```
如果 schema 与下面假设的不一致，回来按真实 schema 改 `parseResults`。

**Files:**
- Create: `~/.pi/agent/extensions/web-search/backends/opencli.ts`

- [ ] **Step 1: 写 opencli.ts**

```typescript
// backends/opencli.ts

import { spawn } from "node:child_process";
import type { Backend, SearchResult } from "./types";

async function which(cmd: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const p = spawn("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    p.once("exit", (code) => resolve(code === 0));
    p.once("error", () => resolve(false));
  });
}

function runOpencli(
  query: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "opencli",
      ["google", "search", query, "-f", "json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()));

    const onAbort = () => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 250).unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    proc.once("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    proc.once("exit", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (code !== 0) {
        const msg = stderr.trim() || `opencli exit ${code}`;
        reject(new Error(msg));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseResults(raw: string): SearchResult[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("opencli output is not JSON");
  }

  // opencli 通用形态：{ ok: true, data: [...] } 或 { data: { items: [...] } }
  // 真实样例确认后调整这里。下面是兼容性最广的解析。
  const candidates = collectArrays(data);
  for (const arr of candidates) {
    const mapped = arr
      .map(toSearchResult)
      .filter((r): r is SearchResult => r !== null);
    if (mapped.length > 0) return mapped;
  }
  return [];
}

function collectArrays(node: unknown, out: unknown[][] = []): unknown[][] {
  if (Array.isArray(node)) out.push(node);
  else if (node && typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) {
      collectArrays(v, out);
    }
  }
  return out;
}

function toSearchResult(item: unknown): SearchResult | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const title =
    pickString(o, ["title", "name", "heading"]) ?? "";
  const url =
    pickString(o, ["url", "link", "href"]) ?? "";
  const snippet =
    pickString(o, ["snippet", "description", "text", "summary"]) ?? "";
  if (!title || !url) return null;
  return { title, url, snippet };
}

function pickString(
  o: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export const opencliBackend: Backend = {
  name: "opencli",

  async isAvailable() {
    if (!(await which("opencli"))) return false;
    // 不跑 opencli doctor — 浏览器 bridge 离线时 doctor 也常返非 0
    // 真实可用性等 search() 调用时再判定
    return true;
  },

  async search(query, signal) {
    const stdout = await runOpencli(query, signal);
    return parseResults(stdout);
  },
};
```

- [ ] **Step 2: 验证 isAvailable**

```bash
node --input-type=module -e "
import { opencliBackend } from './backends/opencli.ts';
console.log('isAvailable:', await opencliBackend.isAvailable());
"
```
（在 web-search 目录下执行）

Expected：`isAvailable: true`（你装了 opencli）或 `false`（没装）。

- [ ] **Step 3: 校准 parseResults — 如果 opencli daemon 在跑就用真实输出回归一次**

如果 `opencli google search "test" -f json` 能正常返结果，跑：

```bash
cd ~/.pi/agent/extensions/web-search && node --input-type=module -e "
import { opencliBackend } from './backends/opencli.ts';
const ctl = new AbortController();
const t = setTimeout(()=>ctl.abort(), 10000);
const r = await opencliBackend.search('rust async', ctl.signal);
clearTimeout(t);
console.log('got', r.length, 'results, first:', r[0]);
"
```

Expected: 拿到 ≥ 1 条结果，`title/url/snippet` 都非空。**如果输出空 → 看 `/tmp/opencli-sample.json` 的实际字段名，回头改 `pickString` 的候选键**。

如果 opencli bridge 没连（你目前的情况），跳过 Step 3 — Task 7 集成测试会再来一次。

---

## Task 6: Browser Backend（`backends/browser.ts`，v1 仅 browser-harness）

**Files:**
- Create: `~/.pi/agent/extensions/web-search/backends/browser.ts`

- [ ] **Step 1: 写 browser.ts（v1：仅 browser-harness 路径）**

```typescript
// backends/browser.ts

import { spawn } from "node:child_process";
import type { Backend, SearchResult } from "./types";

async function which(cmd: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const p = spawn("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    p.once("exit", (code) => resolve(code === 0));
    p.once("error", () => resolve(false));
  });
}

function pickBackend(): "harness" | "playwright" | null {
  const forced = process.env.PI_WEB_SEARCH_BROWSER_BACKEND;
  if (forced === "harness" || forced === "playwright") return forced;
  // auto: 仅检查同步可见信息；isAvailable 中再做异步检测
  return "harness";
}

// browser-harness Python 脚本：访问 DDG HTML 端口（更稳定的选择器），收集结果
const HARNESS_SCRIPT = (query: string) => `
import json, urllib.parse
q = ${JSON.stringify(query)}
u = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(q)
new_tab(u)
wait_for_load()
items = js("""
  Array.from(document.querySelectorAll('div.result, div.web-result')).slice(0, 10).map(el => {
    const a = el.querySelector('a.result__a, a.result-title');
    const s = el.querySelector('.result__snippet, .result-snippet');
    return a ? { title: a.innerText.trim(), url: a.href, snippet: s ? s.innerText.trim() : '' } : null;
  }).filter(Boolean)
""")
print("__RESULTS_JSON__" + json.dumps(items))
`;

function runHarness(query: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("browser-harness", [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()));

    const onAbort = () => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 500).unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    proc.once("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    proc.once("exit", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return reject(new Error("aborted"));
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `harness exit ${code}`));
      }
      resolve(stdout);
    });

    proc.stdin.write(HARNESS_SCRIPT(query));
    proc.stdin.end();
  });
}

function parseHarnessOutput(stdout: string): SearchResult[] {
  const idx = stdout.indexOf("__RESULTS_JSON__");
  if (idx < 0) return [];
  const tail = stdout.slice(idx + "__RESULTS_JSON__".length);
  const lineEnd = tail.indexOf("\n");
  const jsonStr = lineEnd >= 0 ? tail.slice(0, lineEnd) : tail;
  try {
    const arr = JSON.parse(jsonStr) as Array<{
      title: string;
      url: string;
      snippet: string;
    }>;
    return arr
      .filter((x) => x && x.title && x.url)
      .map((x) => ({
        title: x.title,
        url: x.url,
        snippet: x.snippet ?? "",
      }));
  } catch {
    return [];
  }
}

export const browserBackend: Backend = {
  name: "browser",

  async isAvailable() {
    const chosen = pickBackend();
    if (chosen === "harness") return await which("browser-harness");
    // playwright 路径（v2）：暂时返 false，留给将来扩展
    return false;
  },

  async search(query, signal) {
    const chosen = pickBackend();
    if (chosen !== "harness") {
      throw new Error(`browser backend "${chosen}" not implemented yet`);
    }
    const out = await runHarness(query, signal);
    return parseHarnessOutput(out);
  },
};
```

> **v1 说明：** 故意先不接 playwright。
> - `PI_WEB_SEARCH_BROWSER_BACKEND=playwright` 强制时 `isAvailable()` 会返 false，跳过这一层
> - `auto` 模式下用 browser-harness
> - 等用户真的需要 playwright 路径再加（未来的 Task）

- [ ] **Step 2: 验证 isAvailable 与基础抓取（如果 browser-harness daemon 已连接到你的 Chrome）**

```bash
node --input-type=module -e "
import { browserBackend } from './backends/browser.ts';
console.log('available:', await browserBackend.isAvailable());
"
```
（在 web-search 目录下执行）

Expected: `true`（你装了）或 `false`。

实际抓取留到 Task 7。

---

## Task 7: 整合 `index.ts`

**Files:**
- Modify: `~/.pi/agent/extensions/web-search/index.ts` — 完整重写

- [ ] **Step 1: 重写 index.ts**

```typescript
/**
 * Web Search — 多后端回退链版
 *
 * 默认链：brave → opencli → browser
 * 配置：
 *   - PI_WEB_SEARCH_CHAIN="brave,opencli,browser"
 *   - PI_WEB_SEARCH_TIMEOUT_BRAVE / _OPENCLI / _BROWSER  (毫秒)
 *   - PI_WEB_SEARCH_TOTAL_TIMEOUT  (毫秒，默认 15000)
 *   - PI_WEB_SEARCH_BROWSER_BACKEND=auto|harness|playwright
 *   - BRAVE_SEARCH_API_KEY  (Brave 后端启用条件)
 *
 * 运行时调用参数 chain 数组可临时覆盖。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

import { registerBackend, runChain, loadConfig } from "./chain";
import { braveBackend } from "./backends/brave";
import { opencliBackend } from "./backends/opencli";
import { browserBackend } from "./backends/browser";
import type { BackendAttempt, SearchResult } from "./backends/types";

registerBackend(braveBackend);
registerBackend(opencliBackend);
registerBackend(browserBackend);

function formatResults(backend: string, results: SearchResult[]): string {
  const lines: string[] = [`[backend: ${backend}] (${results.length} results)`, ""];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push("");
  });
  return lines.join("\n");
}

function formatFailure(query: string, attempts: BackendAttempt[]): string {
  const lines = [`Web search failed for "${query}". Backends tried:`];
  for (const a of attempts) {
    const tag =
      a.status.kind === "skipped"
        ? "SKIPPED"
        : a.status.kind === "failed"
          ? "FAILED"
          : a.status.kind === "empty"
            ? "EMPTY"
            : "OK";
    const reason =
      a.status.kind === "ok"
        ? `${a.status.results.length} results`
        : a.status.reason;
    lines.push(`  - ${a.name}: ${tag} (${reason}) [${a.elapsedMs}ms]`);
  }
  if (attempts.length === 0) {
    lines.push("  (no backends registered or chain is empty)");
  }
  lines.push("");
  lines.push(
    "Hint: set BRAVE_SEARCH_API_KEY, ensure opencli Browser Bridge is connected, " +
      "or install browser-harness.",
  );
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via Brave → opencli → browser fallback chain. " +
      "Returns search results with titles, URLs, and snippets. " +
      "Use this for current information, recent events, docs, and API references.",
    promptSnippet: "Search the web with backend fallback",
    promptGuidelines: [
      "Use web_search when the user asks about current events, recent information, or facts you are not confident about.",
      "Use web_search when you need to look up documentation, APIs, or technical references online.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      mode: StringEnum(["instant", "full"] as const, {
        description:
          '"instant" returns from the first available backend; "full" runs the full chain until a non-empty match',
        default: "full",
      }),
      chain: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional override of the fallback chain (e.g. ['opencli','brave']). Unknown names are silently dropped.",
        }),
      ),
    }),
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as {
        query?: string;
        mode?: string;
        q?: string;
        chain?: string[];
      };
      if (!input.query && input.q) {
        return { ...input, query: input.q };
      }
      if (!input.mode) {
        return { ...input, mode: "full" };
      }
      return args;
    },

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Search cancelled" }] };
      }

      onUpdate?.({
        content: [
          { type: "text", text: `Searching for: "${params.query}"...` },
        ],
      });

      const effectiveSignal = signal ?? new AbortController().signal;
      const result = await runChain(params.query, effectiveSignal, {
        chain: params.chain,
        shortCircuit: params.mode === "instant",
      });

      let text: string;
      if (result.kind === "ok") {
        text = formatResults(result.backend, result.results);
      } else {
        text = formatFailure(params.query, result.attempts);
      }

      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let output = truncation.content;
      if (truncation.truncated) {
        output += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines shown]`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: {
          query: params.query,
          mode: params.mode,
          chain: result.kind === "ok" ? result.backend : "FAILED",
          attempts: result.attempts.map((a) => ({
            name: a.name,
            kind: a.status.kind,
            elapsedMs: a.elapsedMs,
          })),
        },
      };
    },
  });

  pi.registerCommand("search", {
    description: "Search the web (e.g. /search rust async tutorial)",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /search <query>", "warning");
        return;
      }
      const result = await runChain(args, ctx.signal);
      const text =
        result.kind === "ok"
          ? formatResults(result.backend, result.results)
          : formatFailure(args, result.attempts);

      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let output = truncation.content;
      if (truncation.truncated) {
        output += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines shown]`;
      }
      ctx.ui.notify(output, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const cfg = loadConfig();
    ctx.ui.notify(
      `🔌 Web Search loaded — chain: ${cfg.chain.join(" → ") || "(empty)"}`,
      "info",
    );
  });
}
```

- [ ] **Step 2: 加载扩展，从 pi 内执行 `/search` 验证全链路**

```bash
pi -p '/search rust async tutorial' 2>&1 | tail -30
```

Expected: 看到 `[backend: brave] (N results)` 之类输出。如果没设 key 应该回退到 opencli 或 browser。

如果 pi 失败说扩展加载错误，跑：

```bash
pi --verbose -p '/search test' 2>&1 | grep -iE 'error|extension|web-search' | head
```

并按 error 信息修代码（最常见：相对 import 缺 `.ts` 扩展名 — jiti 通常宽容，但若提示要加，全部 import 加上即可）。

---

## Task 8: 删除旧实现的 backup

**Files:**
- Delete: `~/.pi/agent/extensions/web-search/index.ts.bak`

只在 Task 7 完整通过、`/search` 跑通了真实回退至少一次后再做这步。

- [ ] **Step 1: 删除备份**

```bash
rm ~/.pi/agent/extensions/web-search/index.ts.bak
```

- [ ] **Step 2: 最终目录结构核对**

```bash
find ~/.pi/agent/extensions/web-search -type f | sort
```

Expected：
```
.../web-search/backends/brave.ts
.../web-search/backends/browser.ts
.../web-search/backends/opencli.ts
.../web-search/backends/types.ts
.../web-search/chain.ts
.../web-search/docs/2026-05-20-web-search-refactor-design.md
.../web-search/docs/2026-05-20-web-search-refactor-plan.md
.../web-search/index.ts
.../web-search/validate.ts
```

---

## Task 9: 烟雾测试（覆盖回退路径）

每条单独跑一次，看 `details.chain` 是否走到了预期的 backend。

- [ ] **Step 1: brave 路径（设 key）**

```bash
BRAVE_SEARCH_API_KEY="<your-key>" pi -p '/search anthropic claude api' 2>&1 | tail -20
```
Expected：`[backend: brave]`

- [ ] **Step 2: opencli 路径（不设 brave key，启动 opencli bridge）**

```bash
unset BRAVE_SEARCH_API_KEY
# 先确保 opencli daemon + Chrome 扩展跑起来
opencli doctor
pi -p '/search rust async' 2>&1 | tail -20
```
Expected：`[backend: opencli]`

- [ ] **Step 3: browser 路径（没 brave、关 opencli）**

```bash
unset BRAVE_SEARCH_API_KEY
opencli daemon stop 2>/dev/null || true
pi -p '/search github trending' 2>&1 | tail -20
```
Expected：`[backend: browser]`（前提是 browser-harness 已装且连到 Chrome）

- [ ] **Step 4: 完全失败聚合错误**

```bash
unset BRAVE_SEARCH_API_KEY
opencli daemon stop 2>/dev/null || true
PI_WEB_SEARCH_BROWSER_BACKEND=playwright pi -p '/search whatever' 2>&1 | tail -20
```
Expected：`Web search failed`，三层都给出原因。

- [ ] **Step 5: 关键词验证短路（空命中）**

```bash
BRAVE_SEARCH_API_KEY="<your-key>" pi -p '/search zxqvbnmqwerty1234nothing' 2>&1 | tail -20
```
Expected：Brave 应该返了一些不相关结果，但被关键词验证判 EMPTY，链下钻到 opencli/browser，最终很可能整链 fail。**关键是不能整链等满 20 秒**。

- [ ] **Step 6: 取消测试**

启动一个交互式 pi，手动 `/search` 一个慢查询然后立刻 Ctrl-C。应立即停止，不挂 30s+。

- [ ] **Step 7: 配置覆盖验证**

```bash
PI_WEB_SEARCH_CHAIN="opencli,brave" pi -p '/search foo' 2>&1 | grep -i "chain:"
```
Expected：启动提示打印 `chain: opencli → brave`。

---

## 实施完成后

如果一切跑通，把以下信息附在最后的 PR/commit message 或 changelog 里：

- 新增配置：环境变量列表（参见 `chain.ts` 与 design.md 第 3.4/3.6 节）
- 删除：DDG instant / DDG HTML 抓取（无可恢复，从 git 历史拿）
- 已知限制：playwright 路径未实现（设计预留）；opencli JSON schema 用启发式解析（如真实结构变化需更新 `parseResults`）

---

## Self-Review Notes

我审了一下这份 plan vs spec：

- 设计 §3.1 目录结构 → Task 0-8 都对齐
- 设计 §3.2 契约 → Task 1 全覆盖
- 设计 §3.3 回退链行为（skip/fail/empty 分类） → Task 3 `runChain` 中分支齐全
- 设计 §3.4 超时 → Task 3 `loadConfig` 与 `runChain` 实现完整（per + total）
- 设计 §3.5 关键词验证 → Task 2 实现，Task 3 串联
- 设计 §3.6 配置优先级 → Task 3 实现：override → env → default
- 设计 §3.7 backend 注册 → Task 7 集中注册
- 设计 §4.1-4.3 各 backend → Task 4/5/6 一一对应
- 设计 §5 工具/命令接口 → Task 7 完整重写
- 设计 §6 取消与错误 → Task 3 `runChain` 中处理（parent signal forwarding + per/total controller）
- 设计 §7 兼容性 → Task 7 `prepareArguments` 保留 q→query 与 mode 默认
- 设计 §8 测试 → Task 9 全覆盖
- 设计 §9 实施顺序 → Task 1→4→5→6→7→8 与 spec 推荐顺序基本一致
- 设计 §10 风险：
  - 多文件加载 — 已用 `jiti` 调研确认支持
  - opencli schema — Task 5 用启发式解析 + 强制手工抓样例核对
  - browser-harness — 故意做轻，超时短，失败可接受
  - Brave 速率限制 — Task 4 不重试

**类型/方法名一致性核对**（写后扫了一遍）：

- `SearchResult`、`Backend`、`BackendStatus`、`BackendAttempt` 在所有 Task 中拼写一致
- `registerBackend` / `runChain` / `loadConfig` 在 chain.ts 与 index.ts 中一致
- `braveBackend` / `opencliBackend` / `browserBackend` 命名一致

无 placeholder（无 TODO / TBD / "fill in later"）。
