# pi-wf Stealth 增强 (2026-06-15)

## 动机

`pi-wf` 的 Playwright fallback 被目标站点识别为自动化工具。当前 stealth init script（~30 行，覆盖 6 个信号）不够——2026 年反爬检测已扩展到 plugins/mimeTypes/canvas 指纹/硬件一致性等领域。

## 改动

文件：`extensions/web-fetch/core.ts`，两处改动。

### 1. `STEALTH_SCRIPT` — 30 行 → ~120 行

| # | 信号 | 之前 | 之后 |
|---|------|------|------|
| 1 | `navigator.webdriver` | `delete navigator.__proto__.webdriver` | 不变 ✅ |
| 2 | `window.chrome.runtime` | `{ runtime: {} }` | 完整 mock：`connect` / `sendMessage` / `onConnect` / `onMessage` / `getManifest` / `getURL` + `loadTimes` / `csi` |
| 3 | `navigator.plugins` | ❌ 空（headless 特征） | 2 个 PDF 插件（含 `namedItem` / `item` / `refresh`） |
| 4 | `navigator.mimeTypes` | ❌ 空 | `application/pdf` + `text/pdf`，`enabledPlugin` 正确回指 plugins |
| 5 | `navigator.vendor` | ❌ 未覆盖 | `"Google Inc."` |
| 6 | `navigator.hardwareConcurrency` | ❌ 服务器真实核数 | 固定为 8 |
| 7 | `navigator.deviceMemory` | ❌ `undefined` | 固定为 8 |
| 8 | `navigator.maxTouchPoints` | ❌ 未覆盖 | 固定为 0 |
| 9 | Canvas 指纹 | ❌ 无防护 | `toDataURL` 随机注入 ±0.2 通道噪声 |
| 10 | `window.outerWidth/Height` | ❌ headless 为 0 | 固定为 1280×800 |
| 11 | `screen.colorDepth/pixelDepth` | ❌ 可能异常 | 固定为 24 |
| — | `navigator.platform` | `MacIntel` | 不变 ✅ |
| — | `navigator.languages` | `['zh-CN','zh','en']` | 不变 ✅ |
| — | `navigator.userAgentData` | Chrome 122 on macOS arm | 不变 ✅ |
| — | WebGL vendor/renderer | Intel Iris | 不变 ✅ |
| — | Permissions: notifications | `prompt` 而非 `denied` | 不变 ✅ |

插件/mimeType 实例共享在同一 IIFE 闭包中，`mimeTypes[0].enabledPlugin === plugins[0]` 严格相等。

### 2. Chrome 启动参数

```
之前:
  --disable-blink-features=AutomationControlled
  --disable-dev-shm-usage
  --no-sandbox

之后:
  --disable-blink-features=AutomationControlled
  --disable-features=Translate,OptimizationHints,MediaRouter
  --disable-field-trial-config           // 不泄露 Chrome 实验分组
  --disable-dev-shm-usage
  --no-sandbox
  --disable-gpu                          // 减少 headless GL 错误日志
```

## 局限性

JS 层补丁无法消除以下信号（需二进制级补丁，如 Patchright / nodriver）：

| 信号 | 来源 |
|------|------|
| CDP `Runtime.enable` 全局调用 | Playwright 启动时强制启用 |
| `window.__pwInitScripts` | Playwright `addInitScript` 注入 |
| `window.__playwright__binding__` | Playwright `exposeBinding` 注入 |
| TLS/JA4 指纹 | Linux headless Chromium 的 TLS 握手与真实浏览器不同 |
| CDP 序列化侧信道 | Error 对象的 `stack` getter 被 CDP 触发可检测 |

**如果目标站点是 Cloudflare Turnstile / DataDome 级别** → 需要换用 Patchright（Playwright fork，已补丁 CDP 泄漏）。benchmark: Patchright 25/31 OK vs vanilla 24/31；唯一全过的工具是 nodriver（Python only，28/31 OK，0 blocked）。

**对于知乎/微博/小红书** → 已通过 `PI_WF_PLAYWRIGHT=1` + `launchPersistentContext` + cookie 复用绕过，不需要此增强。

## 验证方法

```bash
# 1. 代码加载检查
cd extensions/web-fetch
node --experimental-strip-types -e 'import("./core.ts").then(() => console.log("OK"))'

# 2. 在线检测面板（需 Playwright 已安装）
PI_WF_PLAYWRIGHT=1 pi-wf https://bot.sannysoft.com
# 或
PI_WF_PLAYWRIGHT=1 pi-wf https://browserscan.net
```
