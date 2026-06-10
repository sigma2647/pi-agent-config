# web-fetch 扩展踩坑记录

## 症状

`pi-wf <url>` 终端能拿到内容，但 pi agent 调用 `web_fetch` 工具返回 HTTP 5xx 或空，报错提示 "Page may be JavaScript-rendered or login-gated"（完全误导）。

## 根因

**pi-wf 和 web_fetch 调用的是完全相同的 `fetchAndExtract()` 函数，没有代码路径差异。** 差异在于 Cloudflare 边缘节点到源站的间歇性可达性问题，你的终端请求和 agent 请求可能命中不同 Cloudflare 节点 / 时间窗口。

但代码层面有两个防御性缺陷：

### 1. HTTP 5xx 后仍然跑完整条 fallback 链

`extractViaHttp` 收到 502/503/522 等 5xx 错误后，继续尝试 defuddle → Jina → Playwright，全部打同一个不可达 URL，浪费 ~10s。最终 fallback 链耗尽时给的是通用提示 "JS-rendered or login-gated"，对 5xx 完全不适用。

**修法**：`fetchAndExtract()` 的提前返回分支增加 `httpResult.error.startsWith("HTTP 5")`。

### 2. `extractWithDefuddle` 请求头不完整

`extractViaHttp` 发完整浏览器头（`Sec-Fetch-Dest`、`Sec-Fetch-Mode`、`Accept-Language` 等），`extractWithDefuddle` 只发 `User-Agent`。不一致的请求特征可能触发不同 CDN/反爬策略。

**修法**：`extractWithDefuddle` 补齐与 `extractViaHttp` 相同的浏览器头。

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
