## Node fetch + 外部 undici 不可混用

Node 原生 `fetch` 用的是**内置 undici**，`dispatcher` 参数只接受**同一份 undici** 的 `Dispatcher`。当 pi 通过 npm 安装时，它会带上自己 bundled 的 undici（位于安装路径下的 `node_modules/undici`）；扩展里 `import("undici")` 拿到的 `ProxyAgent` 来自这份外部 undici，跟 Node 内置那份不是同一个 class — 直接喂给原生 `fetch` 会抛 `UND_ERR_INVALID_ARG`。

**修法**：用外部 undici 的 `ProxyAgent` 时，也用**同一份 undici 的 `fetch`**。或者退一步：`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=... node ...` 启动，让内置 undici 自己处理代理。
