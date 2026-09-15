# 加一个模型 / 加一个服务

- 日期：2026-09-14
- 目的：以后加本地模型、加云端服务，都只有一种做法，而且不用改分发逻辑。
- 适用范围：pi-dictation 扩展（`extensions/dictation/`）。

---

## 0. 两条扩展点，四个格子

扩展里只有两处「清单」，两处都是**表**，不是 `switch` / `if-else`：

| 清单 | 文件 | 键 | 一项 =
|---|---|---|---|
| 后端注册表 | `providers/index.ts` 的 `BACKENDS` | 配置里的 `type` | 一个协议（本地 / openai-compatible / deepgram / …） |
| 本地模型家族注册表 | `local/families/index.ts` 的 `LOCAL_FAMILIES` | 模型目录里的 `family` | 一类模型结构（sense-voice / fire-red-asr-ctc / streaming-zipformer / …） |

两张表都是穷尽的 `Record`：**类型里加了新键、表里没登记，`tsc` 直接报错**，不会静默走错分支。

按「要加什么」选格子：

| 你要加的东西 | 动哪里 | 代码量 |
|---|---|---|
| 云端服务，接口是 OpenAI 的 `/audio/transcriptions` 形状 | `~/.pi/agent/dictation.json` 加一条 `providers.<id>` | 0 行 |
| 云端服务，自己的协议（签名、WebSocket、两步轮询） | `providers/<名字>.ts` + `BACKENDS` 一行 | 1 个文件 |
| 本地模型，结构和现有家族一样 | `local/catalog.ts` 加一条 | 1 条数据 |
| 本地模型，结构是新的家族 | `local/families/<名字>.ts` + `LOCAL_FAMILIES` 一行 | 1 个文件 |
| 本地模型，大到 WASM 运行时装不下 | **别进扩展**：本机起个 OpenAI 兼容服务（`scripts/qwen3-asr-server.py` 是例子），走第一格 | 0 行 |

---

## 1. 云端服务：OpenAI 兼容（首选，0 行代码）

只要对方接受 `multipart/form-data`、返回 JSON 里的 `text`，就加一条配置：

```json
{
  "providers": {
    "my-service": {
      "type": "openai-compatible",
      "endpoint": "https://example.com/v1/audio/transcriptions",
      "model": "their-model-name",
      "language": "auto",
      "apiKeyEnv": "THEIR_API_KEY"
    }
  }
}
```

规则（由 `providers/endpoint.ts` 强制）：

- `https` 必须；`http` 只允许 localhost。
- localhost 不发密钥 —— 所以本机服务（whisper.cpp、faster-whisper、vLLM、本仓库的 `scripts/qwen3-asr-server.py`）不需要 key，`providerStatus` 直接算「就绪」。
- 密钥写 `apiKeyEnv`（环境变量名，推荐）或 `apiKey`（明文，打印时会被隐藏）。

已按这条接好的例子：`openai`、`groq`、`siliconflow`、`glm`（智谱 `glm-asr-2512`）。

## 2. 云端服务：自己的协议（一个文件）

写 `providers/<名字>.ts`，导出**一个描述符**（`Backend` 类型，见 `providers/types.ts`）：

```ts
import type { Backend } from "./types.ts";

export const myProviderBackend: Backend<MyProviderConfig> = {
  create: (id, config, env) => ({ id, label: "My provider", kind: "cloud", async transcribe(input) { /* … */ } }),
  status: (id, config, env) => ({ id, kind: "cloud", label: "…", ready: /* 有 key 吗 */ true, detail: "…" }),
};
```

然后在 `providers/index.ts` 的 `BACKENDS` 加一行。参考实现：`providers/deepgram.ts`（key + 原始音频体 + 自己的 JSON 结构），`providers/openai-compatible.ts`（含 localhost 免密钥的判断）。

`status` 里的 `ready` 只代表「现在能跑」：本地模型看文件 + 运行时，云端看 key 是否在。它不发起网络请求。

记得给 `config.ts` 的 `ProviderConfig` 加类型，并在 `DEFAULT_CONFIG.providers` 加默认条目（不想要就别加，用户自己配也行）。要在 `provider: "auto"` 的备选顺序里，再改 `AUTO_PROVIDER_ORDER`。

## 3. 本地模型：现有家族（一条数据）

`local/catalog.ts` 加一条。**文件名的唯一来源是这里**，家族模块只负责把这些名字翻译成 sherpa-onnx 的配置字段：

```ts
"my-model": {
  id: "my-model",
  label: "…",
  languages: "…",
  sizeMb: 0,
  url: "https://…/my-model.tar.bz2",
  kind: "offline",            // "offline" 说完再出字；"streaming" 边说边出字
  family: "sense-voice",      // 用哪个家族
  weights: "model.int8.onnx", // 家族需要的文件，写在这里
  tokens: "tokens.txt",
  maxSeconds: 60,             // 可选：超过就拒绝，而不是让运行时崩
},
```

- 下载、解压、删除、`/dictation model` 列表都会自动认识它。
- `files`（哪些文件算下载完整）由家族算出来，不用手写两遍。
- 家族要求的字段漏了会立刻报错，并指出是哪个模型缺哪个字段。

## 4. 本地模型：新家族（一个文件）

写 `local/families/<名字>.ts`，导出 `LocalFamily`：

```ts
export const myFamily: LocalFamily = {
  id: "my-family",
  files: (spec) => [specFile(spec, "weights"), specFile(spec, "tokens")],
  offline: (spec, dir) => ({
    mySherpaOnnxKey: { model: join(dir, specFile(spec, "weights")) },
    tokens: join(dir, specFile(spec, "tokens")),
  }),
  // online: (spec, dir) => ({ … })   // 只有能边说边出字的家族才写
};
```

然后在 `local/families/index.ts` 的 `LOCAL_FAMILIES` 加一行，并在 `LocalModelSpec["family"]` 的联合类型里加上这个 id。

- `offline` 和 `online` 返回的是 sherpa-onnx 的 `modelConfig`，公共字段（`numThreads` / `provider` / `debug`）由 `local/provider.ts` 和 `local/streaming.ts` 补。
- 家族缺哪种能力，就在那边报错说明，不会跑到一半才失败。
- 键名要和 `node_modules/sherpa-onnx/sherpa-onnx-asr.js` 里的 `initSherpaOnnxOffline<家族>ModelConfig` 对齐。

## 5. 本地大模型：不要塞进 WASM

WASM 运行时对内存很敏感。实测：FireRedASR2-CTC（740 MB 权重）在 60 秒音频能跑、90 秒直接 abort 整个模块；Qwen3-ASR 0.6B 的 ONNX 版本（约 980 MB 权重）**加载就 abort**。

所以：

- 能进 WASM 的模型 → 走第 3 / 4 格。
- 进不去的模型 → 本机起一个 OpenAI 兼容服务，走第 1 格。例子：`scripts/qwen3-asr-server.py`（Qwen3-ASR 0.6B / 1.7B，CPU 也能跑）。
- 一定要放进扩展的模型，务必在目录里写 `maxSeconds`，让 `local/provider.ts` 提前拒绝，而不是让进程死掉。

---

## 6. 加完之后

```bash
cd extensions/dictation
npm test        # 会检查：家族能力与 kind 是否一致、目录字段是否齐全、状态输出格式
npm run check   # tsc：新家族 / 新协议有没有漏登记
```

`test/local.test.ts` 里有一条用例遍历整个目录，检查每个条目的 `kind` 和它的家族能力是否匹配；加错会直接失败。
