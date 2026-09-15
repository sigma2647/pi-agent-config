# DEPLOY.md — pi-ws / pi-wf / pi-dictation 新机部署指南

基于 2026-07-04 Docker (Ubuntu 25.04) 真实部署过程编写。每个 "⚠️ 坑" 都是实际踩过的。
pi-dictation 那节是 2026-09-15 在干净副本上 `npm ci` 实测后补的（见该节的验证记录）。

## 最低系统要求

| 组件 | 版本 | 原因 |
|------|------|------|
| Node.js | ≥ 22.6 | `--experimental-strip-types`（shebang 需要）；pi-dictation 的原生插件是 N-API，无 Node 版本绑定 |
| jq | ≥ 1.6 | `extensions/install.sh` 解析 package.json |
| git | 任意 | clone 仓库（或手动复制） |
| curl / ca-certificates | 任意 | NodeSource 安装脚本 + HTTPS 请求 |
| tar + bzip2 | 任意 | 仅 pi-dictation：解压模型包 |
| 录音后端 | ffmpeg / pw-record / arecord / sox 任一 | 仅 pi-dictation：采音频 |
| 平台 | **glibc** 的 Linux x64/arm64、macOS x64/arm64、Windows x64 | 仅 pi-dictation：`sherpa-onnx-node` 只提供这几个预编译包，**Alpine / musl 不行** |

## 安装步骤

### 1. Node.js

Ubuntu 25.04 及更早版本自带 Node 18.x，**不兼容**。安装 NodeSource 24.x：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node -v  # 应输出 ≥ v24.x
```

Arch：
```bash
pacman -S nodejs  # rolling，通常已是最新版
```

### 2. 系统依赖

```bash
apt install -y jq git ca-certificates curl
```

### 3. 克隆仓库 + 安装依赖

```bash
git clone <repo-url> /opt/pi-agent-config

cd /opt/pi-agent-config/extensions/web-fetch
npm install

cd /opt/pi-agent-config/extensions/dictation
npm ci          # 用 lockfile，不要用 npm install（见下方 pi-dictation 节）
```

⚠️ **坑：npm install 只在 web-fetch 和 dictation 需要。** web-search 有零 npm 依赖（全靠 pi runtime + 动态探测 undici/playwright），不需要单独 `npm install`。

### 4. 安装 CLI 符号链接

```bash
cd /opt/pi-agent-config/extensions
bash install.sh

# 加入 PATH
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

⚠️ **坑：install.sh 不会自动改 PATH。** 脚本会打印 warning，但容易忽略。手动确认 `which pi-ws` 和 `which pi-wf` 能找到。

### 5. 验证

```bash
pi-wf --doctor
pi-ws --doctor
```

两个 doctor 都应无报错地完成（后端不可用是正常的，见下文）。

---

## 代理配置

### 核心原则

`pi-wf` 和 `pi-ws` 的所有 shebang 都包含 `NODE_USE_ENV_PROXY=1`，使 Node 22+ 内置 `fetch` 遵守 `HTTP_PROXY` / `HTTPS_PROXY`。只需设置环境变量：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

⚠️ **坑：代理只监听 127.0.0.1 时，Docker 容器无法访问。**
如果你在 Docker 内运行且使用桥接网络（默认），宿主机的 `127.0.0.1:7890` 对容器不可达。

**解决方案（按推荐度排列）：**

1. **让代理监听 `0.0.0.0`**（最佳）—— 修改 Clash/V2Ray 配置 `allow-lan: true` 或 `listen: 0.0.0.0`，容器内用 `http://172.17.0.1:7890`（Docker 网关 IP）

2. **宿主机端口转发** —— 用 socat/Python 转发 docker0 → localhost：
   ```bash
   # 宿主机上运行（Python 一行）
   python3 -c "
   import socket,threading
   def fwd(a,b):
       while True:
           try:
               d=a.recv(4096)
               if not d: break
               b.sendall(d)
           except: break
       a.close();b.close()
   def h(c):
       r=socket.socket();r.connect(('127.0.0.1',7890))
       t1=threading.Thread(target=fwd,args=(c,r));t1.start()
       t2=threading.Thread(target=fwd,args=(r,c));t2.start()
   s=socket.socket();s.setsockopt(1,2,1);s.bind(('172.17.0.1',7891));s.listen(5)
   while True:
       c,_=s.accept();threading.Thread(target=h,args=(c,)).start()
   "
   # 容器内
   export HTTPS_PROXY=http://172.17.0.1:7891
   ```

3. **`--network=host`** —— Docker 容器共享宿主机网络栈，`127.0.0.1:7890` 直接可达：
   ```bash
   docker run --network=host ...
   ```

⚠️ **坑：`NODE_USE_ENV_PROXY=1` 必须在 Node 启动前设置。** 运行时 `process.env.NODE_USE_ENV_PROXY = '1'` 无效（undici 在 init 时读取一次）。shebang 已处理此问题，直接运行 `pi-wf` 即可；但如果手动 `node dev.ts`，必须带环境变量。

---

## pi-ws 搜索后端

三个后端按 `brave → browser-probe → opencli` 顺序尝试，遇到第一个非空结果即停止。

### Brave（推荐，质量最好）

```bash
# 在 ~/.env 中设置（pi-ws 会自动加载）
echo 'BRAVE_SEARCH_API_KEY=BSA...' >> ~/.env
```

⚠️ **坑：API Key 格式。** 以 `BSA` 开头、约 31 字符。获取地址：https://brave.com/search/api/

### opencli

```bash
npm install -g @jackwener/opencli
```

⚠️ **坑：opencli daemon 必须运行。** `pi-ws --doctor` 只检查 `which opencli`（二进制是否存在），不检查 daemon 是否在线。如果 daemon 未运行，opencli 后端会挂起直到超时（默认 6s），然后 fallback 到 browser-probe。

验证 daemon：
```bash
opencli status  # 或 opencli info
```

### browser-probe（CDP / Playwright）

需要 Chromium 进程监听 `--remote-debugging-port=9222`：

```bash
# 选项 A：Playwright 托管
npx playwright install chromium
# 然后浏览器后端通过 CDP 连接 http://127.0.0.1:9222

# 选项 B：browser-harness（Python）
# 安装 browser-harness 后自动检测
```

⚠️ **坑：`npx playwright install chromium` 下载约 150MB。** 在 Docker 内可能较慢；可挂载宿主机缓存或预下载。

⚠️ **坑：如果不安装 Chromium，browser 后端永远 SKIPPED。** 三个后端全部不可用时，`pi-ws` 返回 `kind: "fail"`——不会无限挂起。

---

## pi-wf 提取链

按 `domain extractor → defuddle → http+Readability → defuddle(middle) → Jina → Playwright` 顺序尝试。

### 基本依赖（必需）

`npm install` 在 `extensions/web-fetch/` 目录下处理全部依赖，无需手动安装。

⚠️ **坑：如果 `npm install` 失败，检查代理。** 某些 npm 包可能被墙（`@mozilla/readability` 在 npmjs.org）。确保 `HTTPS_PROXY` 已设置。

### Playwright（可选，JS 渲染页面需要）

```bash
npx playwright install chromium  # ~150MB
```

⚠️ **坑：只有以下情况 Playwright 才会激活：**
1. 设置了 `PI_WF_PLAYWRIGHT=1`
2. 或目标域名匹配 `PLAYWRIGHT_AUTO_HOSTS`（zhihu / weibo / xiaohongshu）

只有 JS 重度页面才需要——普通 HTML 用 Readability/Defuddle 即可。

### CloakBrowser（可选，反检测增强）

`cloakbrowser` npm 包已随 `npm install` 安装，但二进制需单独下载（~200MB）。缺失时自动回退到标准 Playwright + JS 隐身脚本，不影响基本功能。

### gh CLI（可选，GitHub API 限流提升）

```bash
# Arch
pacman -S github-cli
# Ubuntu
apt install gh
```

未安装时 GitHub 提取器回退到匿名 API（60 req/h），足够日常使用。

---

## pi-dictation 语音输入

上面「最低系统要求」里的 tar/bzip2、录音后端、glibc 平台三项都是为它加的。

### ⚠️ 坑：原生插件，不是 WASM

`sherpa-onnx-node` 本身只有 JavaScript，真正的二进制在一个单独的包 `sherpa-onnx-<platform>-<arch>` 里，由 npm 的 optionalDependencies 按平台自动选装。**没有对应包时 `npm ci` 不会报错，包路径解析也会成功**，失败发生在真正加载的那一刻。

pi 侧已经处理：`pi-dictation doctor` / `providers` 会真的加载一次插件（3 ms），缺失时报：

```text
✓ local [local] — model ready (~/.pi/agent/dictation-models/fun-asr-nano) but the sherpa-onnx runtime is missing — run: cd <dir> && npm install
```

### 安装

```bash
cd /opt/pi-agent-config/extensions/dictation
npm ci                      # 用 npm ci，不要用 npm install
bash ../install.sh          # 装 pi-dictation 到 ~/.local/bin
pi-dictation doctor         # 应全绿
```

⚠️ **坑：仓库的 `package-lock.json` 必须留在 `registry.npmjs.org`。** 本机 npm 若配了镜像源，`npm install` 会把 `resolved` 改写成镜像域名，提交后在别的机器上会失败。`npm ci` 严格遵守 lockfile，不会改写。

### 下载模型

```bash
pi-dictation model                              # 看有哪些、哪个在用
pi-dictation model download sense-voice-small   # 155 MB，默认，快（0.04 RTF）
pi-dictation model download fun-asr-nano        # 802 MB，小声说话/难中文最准，慢（0.21 RTF）
```

模型放在 `~/.pi/agent/dictation-models/`（可用 `PI_DICTATION_MODELS_DIR` 改），全装约 2 GB（含解压与压缩包缓存）。**不需要 GPU，识别过程不联网。**

⚠️ **坑：模型从 GitHub Releases 下载，国内可能需要代理。** 下载走 `curl`，所以它认环境变量：`export HTTPS_PROXY=http://127.0.0.1:7890`。

### 验证

```bash
pi-dictation doctor
pi-dictation transcribe /path/to/any.wav
```

`doctor` 最后一行必须是 `ready`。它也会采样一次麦克风；**没有麦克风权限时 mic 那行会失败，但转写文件仍然可用**。

### 可选：Qwen3-ASR 本机服务

只有想要「最准」才需要（难中文 4.3% CER，对 `fun-asr-nano` 的 5.0%）。代价：3.4 GB 权重 + 约 8.5 GB 常驻内存，CPU 上约 1× 实时。

```bash
cd /opt/pi-agent-config/extensions/dictation
uv run scripts/qwen3-asr-server.py --model Qwen/Qwen3-ASR-1.7B
```

⚠️ **坑：不要加 `--torch-backend=cpu`。** uv 0.12.13 不接受这个参数（`unexpected argument '--torch-backend'`）。脚本内联的 metadata 已经把 PyTorch 锁到 CPU wheel，直接 `uv run` 就行。首次运行会下 3.4 GB 权重，加载约一分钟。

启动后在 `~/.pi/agent/dictation.json` 里加一条 `openai-compatible` provider 指向 `http://127.0.0.1:8123/v1/audio/transcriptions`（仓库默认配置里已有一条 `qwen-local`，指向同一个地址）。

### 验证记录（2026-09-15，干净副本实测）

```bash
mkdir /tmp/fresh && tar --exclude=node_modules -cf - . | (cd /tmp/fresh && tar -xf -)
cd /tmp/fresh && npm ci          # added 140 packages in 3s
# node_modules/ 里出现 sherpa-onnx-node 和 sherpa-onnx-linux-x64
# package-lock.json 的 resolved 仍是 registry.npmjs.org，未被改写
./dev.ts transcribe test/fixtures/raokouling.wav    # 正常出字
```

---

## 常见错误速查

| 错误信息 | 原因 | 解决 |
|----------|------|------|
| `TypeError: fetch failed` | 代理未设置或不可达 | 检查 `HTTPS_PROXY`，验证代理端口 |
| `ERR_MODULE_NOT_FOUND: playwright-utils.ts` | pi-ws doctor 的已修复 bug | 确认使用最新代码 |
| `ERROR: Extracted content appears incomplete` | 页面内容 < 500 字符（正常行为） | 换一个内容更丰富的 URL |
| `connect timed out` + 海外 URL | 容器无代理或代理挂了 | 见上面代理配置章节 |
| `brave: SKIPPED (not available)` | `BRAVE_SEARCH_API_KEY` 未设 | `echo 'BRAVE_SEARCH_API_KEY=...' >> ~/.env` |
| `opencli: SKIPPED (not on PATH)` | opencli 未安装 | `npm install -g @jackwener/opencli` |
| `browser: SKIPPED` | 无 CDP 端点 + 无 browser-harness | 不需要时忽略；需要时安装 Chromium |
| `node: command not found` | Node 未安装或版本太旧 | Ubuntu 需从 NodeSource 装 24.x |
| `local [local] ... the sherpa-onnx runtime is missing` | 没装到平台二进制包（多发生在 musl 发行版） | 在该扩展目录 `npm ci`；Alpine 等 musl 环境不支持 |
| `Cannot find module 'sherpa-onnx-node'` | 该扩展目录没装依赖 | `cd extensions/dictation && npm ci` |
| 模型下载卡住/超时 | GitHub Releases 需要代理 | `export HTTPS_PROXY=http://127.0.0.1:7890` |
| `unexpected argument '--torch-backend'` | uv 版本不支持该参数（旧文档遗留） | 去掉该参数，直接 `uv run` |

---

## Docker 专用注意事项

1. **基础镜像已有 curl/jq/git**（Ubuntu 25.04），但仍建议显式 `apt install` 以确保版本兼容
2. **`NET_ADMIN` capability** —— 如果需要在容器内用 iptables 改代理路由，加 `--cap-add=NET_ADMIN`
3. **repo 复制** —— `docker cp` 比 `git clone` 快（省去网络），但需要排除 `.git` 大文件时可先 `git clone --depth=1`
4. **持久化** —— 如需要保留 Playwright profile / `.env`，挂载 volume：`-v pw-data:/root`

---

## 快速验证脚本

部署完成后运行此脚本，确认一切正常：

```bash
#!/bin/bash
set -e
export PATH="$HOME/.local/bin:$PATH"

echo "=== Doctor ==="
pi-wf --doctor
pi-ws --doctor

echo ""
echo "=== pi-wf: Wikipedia ==="
pi-wf https://en.wikipedia.org/wiki/Example.com | head -5

echo ""
echo "=== pi-ws: Brave search ==="
pi-ws --fast "hello world" | head -5

echo ""
echo "=== pi-dictation ==="
pi-dictation doctor

if [ -f "$HOME/.pi/agent/dictation-models/sense-voice-small/model.int8.onnx" ]; then
  echo "sense-voice-small ok"
else
  echo "! 模型未下载：pi-dictation model download sense-voice-small"
fi

echo ""
echo "✓ All checks passed"
```
