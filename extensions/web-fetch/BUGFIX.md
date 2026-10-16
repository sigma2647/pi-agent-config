# web-fetch 扩展踩坑记录

## 2026-10-14：pypi 返回 Fastly 拦截页 + 13 秒 + 重复抓取 + 静态路径没有 cookie

### 症状

`pi-wf https://pypi.org/project/zpl` 返回 Fastly 的「Oops, something went wrong」页面当正文；同一条命令慢到 13 秒；`browser-probe read` 同一个 URL 又快又对。

### 根因（四个独立缺陷）

1. **拦截页被当成正文返回。** Readability 靠长度阈值挡住了拦截页，但 `engines/jina.ts` 只检查 `<100` 字和两个固定开头，Fastly 那张约 350 字的页全过。r.jina.ai 是机房 IP，撞墙概率比本机浏览器高，于是链子在 jina 这一步「成功」返回，永远到不了 browser-probe。
   **修法**：`core.ts` 抽出 `looksLikeBotWall()`（唯一一份标记表，原先只藏在 `browser-probe.ts` 的内联正则里），readability / defuddle / jina / browser-probe 四处共用；命中就当没有结果，往下走。
2. **连接超时默认 10 秒。** 本机代理 7890 会「接受连接但上游卡死」，undici 默认 10 秒才放弃。
   **修法**：`core.ts` 把连接限时压到 3 秒，**必须写成 `proxyTls`/`requestTls` 里的 `timeout`** —— `connectTimeout` 顶层参数根本不进 ProxyAgent 的 connector（实测仍是 10.5 秒）。
3. **同一个 URL 抓两次。** defuddle-primary 和 readability 各自 fetch 一次，代理卡住时这 3 秒付两遍。
   **修法**：`readability.ts` 拆成 `fetchDocument()`（只管抓 + content-type / PDF / 拦截页判定）与 `extractHtml()`（只管解析给定 HTML）；`core.ts` 抓一次，两个提取器读同一份 HTML。非 HTML 正文和 PDF 直接返回。
4. **静态路径完全不发 cookie。** 登录态只活在 Playwright profile 里，只有走到浏览器才用得上，于是「只需要一个会话 cookie」的页面也要付一次浏览器启动。
   **修法**：新增 `cookies.ts` —— 从**在跑的** browser-probe 活读（`daemon status --json` 门控，daemon 不在就不读、绝不因此启动 Chrome；再 `cookies get --json`），按域名/路径/secure/过期匹配。**不写任何文件**；`--cookies <file>` / `PI_WF_COOKIES` 只作为显式快照覆盖（测试/离线用）。进程内 30 秒缓存。
   **按需读（不在每次抓取付钱）**：`fetchDocument` 先匿名抓一次；只有出现「像是没登录」的信号才读 cookie 并重试**一次**（不循环）——HTTP 401/403、或 200 但正文是拦截页 / JS 空壳（判定复用 `looksLikeBotWall` 与 `isLikelyJSRendered`）。正常页零额外开销（实测 0.19s vs 常读方案 0.45s）；失败路径多两次子进程（~250ms）+ 一次请求。

### 实测（2026-10-14，本机代理间歇性卡死）

- pypi：修前 13s 且内容错；修后 4.2–4.9s（代理卡死那次 3.5s 是连接超时上限）+ 内容正确。
- cookie 机制：本地强制登录的测试站，无 jar 拿到登录短页、带 jar 直接拿到正文（`cookies: 1 matched`，显式文件）；活读路径：daemon 在跑时 `read 159 live in ~240ms`，`17 matched for www.google.com`。
- 真实收益一处：Google SERP 匿名抓是「JS-rendered」→ 走 jina 3.8s；带 jar 后 0.7s 静态出结果。zhihu 带 cookie 仍 403（它要的不只是 cookie），未受益。

### 待办

- 域名提取器（github/reddit/…）自己发 HTTP，**不读 cookie jar**；要覆盖得逐个改。
- browser-probe 的 `cookies get --domain <host>` 会**少给** cookie（CDP 给 URL 过滤器时走 `Network.getCookies`，实测 www.google.com 只回 1 个而 profile 里有 17 个）。所以 pi-wf 不带过滤器读全量，自己过滤。
- daemon 不在时不做活读（会启动 Chrome）；也没有「失败后自动重试带 cookie」的路径。

---

## 症状

`pi-wf <url>` 终端能拿到内容，但 pi agent 调用 `web_fetch` 工具返回 HTTP 5xx 或空，报错提示 "Page may be JavaScript-rendered or login-gated"（完全误导）。

## 根因

**pi-wf 和 web_fetch 调用的是完全相同的 `fetchAndExtract()` 函数，没有代码路径差异。** 差异在于 Cloudflare 边缘节点到源站的间歇性可达性问题，你的终端请求和 agent 请求可能命中不同 Cloudflare 节点 / 时间窗口。

但代码层面有两个防御性缺陷：

### 1. HTTP 5xx 后仍然跑完整条 fallback 链

`extractViaHttp` 收到 502/503/522 等 5xx 错误后，fallback 链耗尽时给的通用提示 "JS-rendered or login-gated" 对 5xx 完全不适用。

**注意**：5xx 与 `fetch failed` 含义相反——`fetch failed` 是"没连上"（DNS/proxy/连接），换条路的 Jina 也撞同一堵墙；5xx 是"连上了、源站吐错"，常为间歇性，Jina Reader 走独立 egress + 缓存可能救活。因此**5xx 不短路**，继续走 Jina → Playwright，只在链耗尽时由 `describeNetworkError` 给准确提示。（早期版本曾把 `HTTP 5` 加进提前返回分支，与本节根因"间歇可达"自相矛盾，已移除。）

### 2. `extractWithDefuddle` 请求头不完整

`extractViaHttp` 发完整浏览器头（`Sec-Fetch-Dest`、`Sec-Fetch-Mode`、`Accept-Language` 等），`extractWithDefuddle` 只发 `User-Agent`。不一致的请求特征可能触发不同 CDN/反爬策略。

**修法**：抽取 `BROWSER_HEADERS` 常量（单一知识源），`extractViaHttp` 与 `extractWithDefuddle` 共用，避免两处头表必须手动同步。

## 相关文件

- `core.ts` — 核心提取逻辑，包含 `fetchAndExtract`、`extractWithDefuddle`、`extractViaHttp` 等
- `index.ts` — pi 扩展入口，注册 `web_fetch` 工具
- `dev.ts` — `pi-wf` CLI 入口（shebang 含 `NODE_USE_ENV_PROXY=1`）

## 调试技巧

```bash
# 开启调试日志，观察 fallback 链每步耗时和结果
PI_WF_DEBUG=1 pi-wf <url>

# 对比 pi agent 内的行为（扩展加载在 pi 进程中，走 pi 的 undici global dispatcher）
# pi agent 的 http-dispatcher 设置了 allowH2: false + 自定义超时
# pi-wf 走 NODE_USE_ENV_PROXY=1 的默认 EnvHttpProxyAgent
# 两者对 HTTP_PROXY/HTTPS_PROXY 的响应一致
```

## 其他可能踩的坑

- **Playwright 只对特定域名自动启用**（`PLAYWRIGHT_AUTO_HOSTS` 正则：zhihu/weibo/xiaohongshu）。其他 Cloudflare 保护站点需手动 `pi-wf --playwright <url>` 或设 `PI_WF_PLAYWRIGHT=1`。
- **信号（signal）**：web_fetch 工具从 pi agent 收到 `AbortSignal`，pi-wf CLI 传 `undefined`。如果 agent 在 fallback 链执行期间被 Esc 取消，`signal.aborted` 的检查散布在 core.ts 多处，会提前终止。
- **编码**：linkedom 的 `parseHTML` 对 Windows-1251 等非 UTF-8 编码可能不自动检测，俄语站点（rutracker）可能乱码。
