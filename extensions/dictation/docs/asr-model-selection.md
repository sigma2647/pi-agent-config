# pi-dictation 语音识别（ASR）选型分析

- 日期：2026-09-12
- 范围：**只说「语音 → 文字」**（听写）。文字 → 语音（TTS）不在范围内。
- 用途：给后续选型做依据。表里的数字都能回溯到「来源」一节的链接。
- 免责：厂商自测的精度数字会高估自己。凡我没亲自跑过的，都标「未验证」。

---

## 0. 结论摘要

| 你的目标 | 选它 | 代价 |
|---|---|---|
| 离线、免费、够用（现在就是） | 保持 `SenseVoice Small int8` | 无 |
| 离线、中文更准 | 加 `FireRedASR2-CTC int8`（496 MB） | 改约 20–40 行代码，磁盘 +740 MB |
| 对标豆包输入法 | 豆包 `Seed-ASR 2.0`（火山引擎） | 要新写一个 provider；按小时付费；要联网 |
| 想先用最简单的方式试云端 | `whisper-large-v3-turbo`（Groq，已有配置） | 中文标点与专名一般 |

**重要更正**：`qwen3-asr-flash` 的「OpenAI 兼容」指的是 **`/chat/completions` 里塞 base64 音频**，不是 `/v1/audio/transcriptions`。pi-dictation 现有的 `openai-compatible` provider 用的是 `/audio/transcriptions` 表单上传，**不能直接用它**。要接 `qwen3-asr-flash` 必须新写 provider。

---

## 1. 排除项

| 模型 | 为什么不选 |
|---|---|
| **Breeze TTS 2**（BreezeBlue） | 是**语音合成**（文字→语音），不是语音识别。3B 参数，要 12 GB 显存，权重只许非商用。和听写无关。 |
| MediaTek Research **Breeze ASR 25 / ASR 26** | Whisper-large-v2 微调，专攻**台湾华语 / 台语 / 中英夹杂**。要 PyTorch + 显卡，进不了 sherpa-onnx 离线流程。普通话听写不比 SenseVoice 划算。 |
| FireRedASR **v1**（`fire-red-asr-large`） | 1.4 GB 压缩包、解压 1.7 GB，官方文档自己写「on CPU somewhat slow」。v2 有更快的 CTC 分支，选 v2。 |

注：MediaTek 的 Breeze 和 BreezeBlue 的 Breeze TTS 2 是两家不同来源，名字撞车。

---

## 2. 现状：pi-dictation 已内置的模型

| id | 类型 | 默认模型 | 需要 | 备注 |
|---|---|---|---|---|
| `local` | 本地离线 | SenseVoice Small int8 | 无 | 155 MB，中/英/日/韩/粤，自带标点 |
| `local` | 本地离线 | x-asr-480ms-zh-en-punct | 无 | 127 MB，中英，**边说边出字**，精度略低于 SenseVoice |
| `openai` | OpenAI 兼容 | `whisper-1` | `OPENAI_API_KEY` | — |
| `groq` | OpenAI 兼容 | `whisper-large-v3-turbo` | `GROQ_API_KEY` | 快；中文标点与专名一般 |
| `siliconflow` | OpenAI 兼容 | `FunAudioLLM/SenseVoiceSmall` | `SILICONFLOW_API_KEY` | 和本地默认同一个模型 |
| `deepgram` | Deepgram | `nova-3` | `DEEPGRAM_API_KEY` | 英文强，中文弱 |

`provider: "auto"` 的优先级：`local → openai → groq → siliconflow → deepgram`。

---

## 3. 候选：本地（sherpa-onnx 已发布的 ONNX 版本）

这些都能离线跑。pi-dictation 已装 `sherpa-onnx` 1.13.8，它的 JS 接口里已经有 `senseVoice`、`fireRedAsrCtc`、`fireRedAsr`、`funAsrNano`、`qwen3Asr`、`dolphin` 这些配置项。

| 模型（sherpa-onnx release 名） | 压缩包 | 解压后主要文件 | 语言 | RTF（官方实测） | 许可 | 接入成本 |
|---|---|---|---|---|---|---|
| `sense-voice-...-int8-2024-07-17`（**现在用的**） | 155 MB | model.int8.onnx | 中英日韩粤 | ≈ 0.1 | other（自定义） | — |
| `sense-voice-...-int8-2025-09-09` | 158 MB | 同上，文件名相同 | 中英日韩粤 | 未核实（应与旧版接近） | other | **改 1 行 URL** |
| `fire-red-asr2-ctc-zh_en-int8-2026-02-25` | 496 MB | model.int8.onnx **740 MB** | 中 + 20 多种方言 + 英 | **0.173**（单线程，5.1 秒短句）<br>0.058（3 线程 + VAD，272 秒） | Apache-2.0 | 中（加分支） |
| `fire-red-asr2-zh_en-int8-2026-02-26`（AED） | 799 MB | encoder 779 MB + decoder 398 MB | 同上 | 0.333 / 0.182（慢一倍） | Apache-2.0 | 中（加分支） |
| `funasr-nano-int8-2025-12-30` | 802 MB | 解压体积**未核实**（fp32 版解压 3.7 GB） | 中英日等 31 种 | 未验证 | Apache-2.0 | 中 |
| `qwen3-asr-0.6B-int8-2026-03-25` | 837 MB | 未核实 | 多语种 + 方言 | 未验证 | Apache-2.0 | 中 |
| `dolphin-base-ctc-multi-lang-int8-2025-04-02` | 76 MB | 未核实 | 多语种（含中文方言） | 未验证 | Apache-2.0 | 中 |

RTF 说明：0.1 表示「10 秒录音花 1 秒识别」。上面的 RTF 来自 sherpa-onnx 官方文档，机器是文档作者的 Mac，CPU、int8、单线程（长音频那行是 3 线程）。**你的机器上未必一样，必须实测。**

其他仍在列表里但没必要的：`paraformer-zh-int8-2025-10-07`（比 SenseVoice 老一代）、`streaming-zipformer-zh-int8-2025-06-30`（比现有流式模型旧）。

补充：sherpa-onnx 支持「模拟流式」——用 VAD 切段，把离线模型当准流式用（文档里有 `simulated_streaming_asr` 的 Android APK 示例）。所以 FireRedASR2-CTC 也有可能做到「边说边出字」，但要改动 pi-dictation 的流式路径。**未验证。**

---

## 4. 候选：云端 API

| 服务 | 模型 | 协议 | 价格（官网口径，需复核） | 接入成本 |
|---|---|---|---|---|
| 火山引擎（字节） | `Doubao_Seed_ASR_Streaming_2.0` | WebSocket `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel` | 4.5 元/小时，QPS 10 | 新写 provider |
| 火山引擎（字节） | `Doubao_Seed_ASR_AUC_2.0`（录音文件） | HTTP 提交 + 轮询 `/api/v3/auc/bigmodel/submit` | 0.8 元/小时 | 新写 provider |
| 阿里百炼 | `qwen3-asr-flash` | `/chat/completions` + base64 音频（号称 OpenAI 兼容） | 第三方转载价 ≈ $0.000035/秒 ≈ 0.9 元/小时 | 新写 provider |
| 阿里百炼 | `qwen-audio-3.0-asr-flash` | HTTP 同步（DashScope 原生） | 见官网 | 新写 provider |
| 阿里百炼 | `qwen-audio-3.0-asr-flash-filetrans`、`fun-asr`、`fun-asr-mtl` | HTTP 异步（先提交拿 task_id，再轮询） | 见官网 | 新写 provider |
| 阿里百炼 | `qwen3-asr-flash-realtime`、`fun-asr-realtime` | WebSocket | 见官网 | 新写 provider（流式） |
| 现有 | `whisper-large-v3-turbo` | `/audio/transcriptions` | 已有 | **0 改动** |
| 现有 | `nova-3` | Deepgram 原生 | 已有 | **0 改动** |
| 自建 | whisper.cpp / faster-whisper / sherpa-onnx server / FireRedASR 自建服务 | `/v1/audio/transcriptions` | 只花电费 | **0 改动**（config 加 `openai-compatible` 条目即可） |

注意：火山引擎和阿里百炼的语音接口都需要**业务空间 / AppID**，不是拿一个 key 就能用。

---

## 5. 精度对比（全部是**厂商自测**，仅供参考）

来源：FireRedASR2S 官方 README（2026-02）。指标是 CER（字错率，越低越好）。

| 数据集 | FireRedASR2-LLM | FireRedASR2-AED | Doubao-ASR | Qwen3-ASR-1.7B | Fun-ASR | Fun-ASR-Nano |
|---|---|---|---|---|---|---|
| 普通话 4 个测试集平均 | **2.89** | **3.05** | 3.69 | 3.76 | 4.16 | 4.55 |
| 19 个方言/口音测试集平均 | **11.55** | **11.67** | 15.39 | 11.85 | 12.76 | 15.07 |
| 全部 24 个测试集平均 | **9.67** | **9.80** | 12.98 | 10.12 | 10.92 | — |

怎么读这张表：

1. 这是小红书为自家模型做的评测。豆包和 Qwen 的数字不是它们自己测的，要打折看。
2. 但趋势和其他第三方横评一致：**FireRedASR 系 > Qwen3-ASR ≈ 豆包 > Fun-ASR ≈ SenseVoice**。
3. **SenseVoice 不在表里。** 公开横评里 SenseVoice 的中文 CER 明显高于上面几个（它强在 155 MB 就能离线跑）。
4. 差距的量级：普通话上 SenseVoice → FireRedASR2 大概能少错三到四成。方言上差距更大。

---

## 6. 接入成本（对着代码说）

| 目标 | 要改什么 | 量 |
|---|---|---|
| 换到 SenseVoice 2025-09-09 | `local/catalog.ts` 里改 `url`（文件名 `model.int8.onnx` + `tokens.txt` 不变） | 1 行 |
| 加 FireRedASR2-CTC | `catalog.ts` 加 spec（新 kind 或 family 字段）+ `local/provider.ts` 的 `loadRecognizer` 加 `fireRedAsrCtc` 分支 + `sherpa-onnx.d.ts` 补类型 | 约 20–40 行 |
| 加 FunASR-Nano / Qwen3-ASR 0.6B | 同上，但模型是多文件（encoder_adaptor + llm + embedding + tokenizer），分支更多 | 约 40–80 行 |
| 加 `qwen3-asr-flash` | 新 `providers/dashscope.ts`：`/chat/completions`，音频转 base64 Data URL，从 `choices[0].message.content` 取文本；在 `providers/index.ts` 注册 | 约 80–120 行 |
| 加豆包 Seed-ASR | 新 `providers/volcengine.ts`：提交任务 + 轮询两步；流式版还要 WebSocket | 约 150+ 行 |
| 接本机自建 ASR 服务器 | 不用写代码。`dictation.json` 加一条 `openai-compatible`，`endpoint` 指向 `http://127.0.0.1:PORT/v1/audio/transcriptions` | 0 行 |

`local/provider.ts` 现在把 `senseVoice` 配置**写死**在 `loadRecognizer` 里，所以本地换模型家族一定要动这个函数；只换同一个家族的新版本则不用动。

---

## 7. 建议方案

### 方案 A：保守（离线、零成本、改动最小）
保持 `SenseVoice Small int8`。把 catalog 里的 URL 换成 `2025-09-09` 版本。旧的流式模型继续留着做「边说边出字」。
- 适合：够用就行，不想维护新代码。

### 方案 B：离线中文最准
在方案 A 基础上加 `FireRedASR2-CTC int8`（496 MB / 解压 740 MB）。它不是流式，体验和现在的 SenseVoice 一样（说完再出字）。
- 代价：磁盘 +740 MB，首次加载变慢（官方文档：创建识别器 0.5 秒），短句延迟变高（RTF 0.17 对 0.1）。
- 想知道实际体感，必须先在本机拿同一段录音对比 RTF 和错字。

### 方案 C：对标豆包输入法
用豆包 `Seed-ASR 2.0`（最接近豆包输入法的同门模型），或者先用**本机自建 FireRedASR 服务**验证效果再决定付不付费。
- 先做的事：找台机器起一个 `/v1/audio/transcriptions` 服务，用现成的 `openai-compatible` 通道对比，**不写代码**先看效果。
- 注意：豆包输入法的准不只是模型。它还有上下文、热词表、你自己的输入历史。只换模型只能解决一半。

推荐顺序：**先做方案 A（几乎零成本），再用方案 C 里的「自建服务对比」决定要不要上 B 或付费云端。**

---

## 8. 未验证与风险

| 项 | 状态 |
|---|---|
| sherpa-onnx 的 **Node/WASM** 环境能否跑 FireRedASR2-CTC / FunASR-Nano / Qwen3-ASR | **未验证**。接口存在，但没实跑过 |
| 各模型在你的机器上的 RTF、首次加载时间、内存占用 | **未实测**。表里是官方文档的数字 |
| FireRedASR2 在 pi-dictation 里能不能做「模拟流式」 | **未验证** |
| 任何云端 key、配额、实际账单 | **未验证** |
| 各厂商自测的精度数字 | 有利益倾向，不可全信 |
| `sherpa-onnx-sense-voice-funasr-nano-int8-2025-12-17`（178 MB）是什么 | **未核实**，名字可疑，没写进候选表 |
| Fun-ASR-Nano / Qwen3-ASR 0.6B 解压后的实际体积 | **未核实** |
| 价格 | 来自官网页面和第三方转载，下单前必须复核 |

许可证提醒：

- **SenseVoiceSmall 是 `license: other`**（自定义许可），不是标准开源协议。商用前要读原文。
- FireRedASR2、Fun-ASR-Nano、Qwen3-ASR、Dolphin 都是 **Apache-2.0**。
- **Breeze TTS 2 的权重是非商用许可**（研究/非商用），自建服务的输出也不能商用。

---

## 9. 来源

| 内容 | 链接 |
|---|---|
| pi-dictation 现有模型与配置 | `extensions/dictation/README.md`、`local/catalog.ts`、`providers/openai-compatible.ts` |
| sherpa-onnx 全部 ASR 模型清单与体积 | https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models |
| FireRedASR2 官方说明、精度表、RTF | https://github.com/FireRedTeam/FireRedASR2S |
| sherpa-onnx 的 FireRedASR 用法与 RTF 实测 | https://k2-fsa.github.io/sherpa/onnx/FireRedAsr/pretrained.html |
| sherpa-onnx 的 FunASR-Nano / Qwen3-ASR | https://k2-fsa.github.io/sherpa/onnx/funasr-nano/pretrained.html |
| 阿里百炼 ASR 模型总表与选型 | https://help.aliyun.com/zh/model-studio/asr-model |
| `qwen3-asr-flash` 的 OpenAI 兼容调用方式 | https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference |
| 豆包语音识别 2.0 与价格 | https://ai.volcengine.com/model |
| 火山引擎录音文件识别接口 | https://docs.volcengine.com/docs/6561/1354868 |
| Breeze TTS 2 模型卡 | https://huggingface.co/BreezeBlue/Breeze-TTS-2 |
| MediaTek Breeze ASR 25 | https://github.com/mtkresearch/Breeze-ASR-25 |
| 许可证 | 各模型 HuggingFace API 的 `license:` 标签 |

---

## 10. 后续怎么用这份文件

把第 3 节的本地候选表转成 CSV（`NF==9` 只匹配 7 列的表，即第 3 节）：

```bash
cd ~/pi-agent-config && awk -F'|' 'NF==9 && /MB/{for(i=2;i<=8;i++) gsub(/^ +| +$/,"",$i); print $2","$3","$4","$5","$6}' \
  extensions/dictation/docs/asr-model-selection.md
```

输出（已实测，2026-09-12）：

```text
`sense-voice-...-int8-2024-07-17`（**现在用的**）,155 MB,model.int8.onnx,中英日韩粤,≈ 0.1
`sense-voice-...-int8-2025-09-09`,158 MB,同上，文件名相同,中英日韩粤,未核实（应与旧版接近）
`fire-red-asr2-ctc-zh_en-int8-2026-02-25`,496 MB,model.int8.onnx **740 MB**,中 + 20 多种方言 + 英,**0.173**（单线程，5.1 秒短句）<br>0.058（3 线程 + VAD，272 秒）
...
```

要真正下结论，需要补齐三件事：

1. 在本机用同一段录音跑 SenseVoice / FireRedASR2-CTC，记录 RTF、错字、内存。
2. 用现成的 `openai-compatible` 通道接一个自建或云端服务，做同样对比。
3. 定一个「够用」的标准（比如：日常听写错字率低于某个值就行），否则永远在选型。
