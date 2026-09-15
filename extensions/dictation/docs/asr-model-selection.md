# pi-dictation 语音识别（ASR）选型分析

- 日期：2026-09-12
- 范围：**只说「语音 → 文字」**（听写）。文字 → 语音（TTS）不在范围内。
- 用途：给后续选型做依据。表里的数字都能回溯到「来源」一节的链接。
- 免责：厂商自测的精度数字会高估自己。凡我没亲自跑过的，都标「未验证」。

---

## 0. 结论摘要

**先读第 10 节和第 11 节（本机实测）。**下面这张表是 2026-09-12 写下的预判，实测数据推翻了其中两条（FireRedASR2-CTC 的 CTC 分支并不比 SenseVoice 准；短句和长句的排名会翻转）。

| 你的目标 | 选它 | 代价 |
|---|---|---|
| 离线、免费、够用（现在就是） | 保持 `SenseVoice Small int8` | 无 |
| 离线、中文更准 | `Fun-ASR-Nano int8`（第 11 节实测：难中文 5.0%，耳语 6.3%，进程内运行） | 磁盘 +949 MB；单段最多 25 秒 |
| 小声说话 / 耳语 | 同上 `Fun-ASR-Nano`，不要用 SenseVoice、FireRedASR2-CTC、Whisper 系或 GLM | 见第 11 节 |
| 离线、中文最准（愿意等） | `Qwen3-ASR-1.7B` 跑在本机服务上 | 权重 3.4 GB；常驻约 8.5 GB 内存；CPU 上约 1× 实时 |
| 对标豆包输入法 | 豆包 `Seed-ASR 2.0`（火山引擎） | 要新写一个 provider；按小时付费；要联网 |
| 想先用最简单的方式试云端 | `whisper-large-v3-turbo`（Groq，已有配置） | 中文标点与专名一般；**中文耳语上不可用（16.33% CER）** |

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
| `local` | 本地离线 | fun-asr-nano | 无 | 949 MB，中英日，**耳语和难中文都好**，单段最多 25 秒，见第 11 节 |
| `local` | 本地离线 | fire-red-asr2-ctc-zh-en | 无 | 740 MB，中文（含 20 多种方言），不出标点，单段最多 60 秒 |
| `local` | 本地离线 | x-asr-480ms-zh-en-punct | 无 | 127 MB，中英，**边说边出字**，精度略低于 SenseVoice |
| `openai` | OpenAI 兼容 | `whisper-1` | `OPENAI_API_KEY` | — |
| `groq` | OpenAI 兼容 | `whisper-large-v3-turbo` | `GROQ_API_KEY` | 快；中文标点与专名一般 |
| `siliconflow` | OpenAI 兼容 | `FunAudioLLM/SenseVoiceSmall` | `SILICONFLOW_API_KEY` | 和本地默认同一个模型 |
| `deepgram` | Deepgram | `nova-3` | `DEEPGRAM_API_KEY` | 英文强，中文弱 |

`provider: "auto"` 的优先级：`local → openai → groq → siliconflow → deepgram`。

本地四个模型同一时间用一个（`providers.local.model`）。耳语、小声说话用 `fun-asr-nano`，见第 11 节。

---

## 3. 候选：本地（sherpa-onnx 已发布的 ONNX 版本）

这些都能离线跑。pi-dictation 用 `sherpa-onnx-node`（原生插件）1.13.8，它的接口里有 `senseVoice`、`fireRedAsrCtc`、`fireRedAsr`、`funasrNano`、`qwen3Asr`、`dolphin` 这些配置项。

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
| 加 FireRedASR2-CTC | `catalog.ts` 加 spec（新 kind 或 family 字段）+ `local/provider.ts` 的 `loadRecognizer` 加 `fireRedAsrCtc` 分支 + `sherpa-onnx-node.d.ts` 补类型 | 约 20–40 行 |
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
| sherpa-onnx 的 **Node/WASM** 环境能否跑 FireRedASR2-CTC / FunASR-Nano / Qwen3-ASR | **已实测**：FireRedASR2-CTC 能跑但 60 秒以上崩；Qwen3-ASR 的 ONNX 版加载就崩。见第 10.4 节 |
| 各模型在你的机器上的 RTF、首次加载时间、内存占用 | **已实测**，见第 10 节 |
| FireRedASR2 在 pi-dictation 里能不能做「模拟流式」 | **仍未验证** |
| 任何云端 key、配额、实际账单 | 部分实测：智谱 GLM key 可连上，但调用 `glm-asr-2512` 返回「余额不足或无可用资源包」 |
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

## 10. 实测（2026-09-14，本机）

这一节取代第 5 节的厂商自测数字：同一批音频、同一台机器、五个模型。

机器：28 核 CPU、125 GB 内存、显卡 GTX 960（2 GB，用不上）。本地模型跑 sherpa-onnx 1.13.8 的 WASM 运行时；Qwen3-ASR 跑官方 `qwen-asr` Python 包（float32、CPU）。

### 10.1 硬中文：`test/fixtures/raokouling.wav`（140 字，标准答案已知）

| 模型 | 字错率 | 错字数 | 错在哪（例） |
|---|---|---|---|
| `Qwen3-ASR-1.7B` | **4.3%** | 6 | 咬死山→瑶山、紫→死、柿→狮、设置→狮子 |
| `sense-voice-small` | 7.1% | 10 | 与→（丢）、自治→自、牛奶奶→刘奶奶、44→四十四 之类 |
| `fire-red-asr2-ctc-zh-en` | 12.1% | 17 | 自制→自质、骨质→质疏、咬死山→瑶紫山、设置→毡奢 |
| `x-asr-480ms-zh-en-punct`（现行配置） | 14.3% | 20 | 开头多出「广西上从自己」 |
| `Qwen3-ASR-0.6B` | 16.4% | 23 | 骨质疏松症→古支书东正、网站设置组→网沾身志组 |

两点修正：

1. **FireRedASR2 的 CTC 分支不如 SenseVoice。** 厂商表里的 3.05% 是 AED 分支，导出的 CTC 分支在这个样本上差一倍。
2. **Qwen3-ASR-0.6B 远不如 1.7B**（厂商表写 4.06% 对 2.44%，实测差 4 倍），所以本机默认用 1.7B。

### 10.2 你自己的两段录音

路径：`~/.local/share/org.gnome.SoundRecorder/`（44.1 kHz FLAC，转 16 kHz 单声道后测试）。

| 句子 | 流式 x-asr | sense-voice | FireRed-CTC | Qwen3-0.6B | Qwen3-1.7B |
|---|---|---|---|---|---|
| 吃葡萄不吐葡萄皮 | 直播打不打葡萄皮（错 5） | 吃葡萄不吐葡萄饼（错 1） | 吃葡萄不涂葡萄病（错 2） | **全对** | **全对** |
| 八百标兵奔北坡 | 那实在不行只能报表被破（全错） | 大败标兵奔被磨（错 3） | 大败标兵奔背波（错 3） | 大败彪兵们，被迫（错 5） | 大败标兵，门被破（错 4） |

**五个模型都把「八」听成「大」。** 两段录音都是开头 10 毫秒就到满音量，第一个音很可能被切掉了——这是录音起点的问题，不是模型的问题。重录时先说一个字垫音，再比才公平。

### 10.3 长音频：272 秒中文演讲（`lei-jun-test.wav`）

参考文本用 FireRedASR2-AED 的官方输出（去标点后 590 字）。只看**替换错字**；插入的字多来自参考没覆盖的段落，不计：

| 模型 | 替换错字 | 耗时 | 备注 |
|---|---|---|---|
| `x-asr-480ms`（流式） | **6** | 32 秒 | 短句差、长句最好，而且最快 |
| `sense-voice-small` | 35 | 93 秒 | |
| `fire-red-asr2-ctc-zh-en` | — | — | 60 秒以上崩，292 秒跑不了 |

**排名会翻转**：硬短句里离线模型赢；两分钟以上的连续讲话里，流式模型反而最准、最快。

### 10.4 运行时限制（把第 8 节的「未验证」变成事实）

| 项 | 实测结果 |
|---|---|
| FireRedASR2-CTC 在 WASM 里能跑多长 | 60 秒能跑，75 秒能跑，90 秒 `abort()`，模块作废、进程需要重启。目录里已写 `maxSeconds: 60`，超限会先报错而不是崩 |
| Qwen3-ASR 0.6B 的 ONNX 版本 | **加载就崩**（权重约 980 MB，属于同一类内存上限）。已从目录删除，改走本机服务 |
| 大模型在本机的速度 | Qwen3-ASR-1.7B：20.76 秒音频算 19.1 秒（≈1× 实时），首次加载 66 秒，权重 3.4 GB；0.6B 加载 36 秒、3–4 秒音频约 1 秒 |
| 智谱 GLM-ASR-2512 | key 能连上，但调用返回「余额不足或无可用资源包，请充值」——要先用起来得买语音资源包 |

### 10.5 现在该怎么配

1. **默认 `sense-voice-small`**：离线、155 MB、带标点，短句长句都不差。
2. **要最准**：本机起服务 `uv run scripts/qwen3-asr-server.py --model Qwen/Qwen3-ASR-1.7B`，配置里加一条 `openai-compatible` 指向 `127.0.0.1`（扩展零改动）。代价是每句话等约一个音频时长。
3. **要边说边出字**：`x-asr-480ms-zh-en-punct`，接受短句会错。
4. `fire-red-asr2-ctc-zh-en` 留着当方言备用；在这个样本上没有优势，而且有 60 秒上限。

### 10.6 追加实测：有没有比 SenseVoice 更好的本地模型（2026-09-15）

同一段 `raokouling.wav`，走扩展自己的转写路径（sherpa-onnx 1.13.8 WASM，单线程，与 10.1 同口径）：

| 模型 | 字错率 | 错字 | 体积 | 结论 |
|---|---|---|---|---|
| `sense-voice-small`（现行默认） | **7.1%** | 10 | 155 MB | 最好 |
| `sherpa-onnx-sense-voice-…-int8-2025-09-09` | 12.9% | 18 | 158 MB | 同族新版反而差，不收录 |
| `sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02` | 27.9% | 39 | 76 MB | 差得远，不收录 |

两个候选都能在 WASM 运行时里正常加载并解码（Dolphin 内部自动把 44.1 kHz 重采样到 16 kHz），所以这不是内存上限问题，是精度问题。测完即从模型目录删除，未写进 `local/catalog.ts`。

官方数字（FunASR 自家 benchmark，GPU）对得上：SenseVoice-Small 7.81%、Paraformer-Large 10.18%、Fun-ASR-Nano 8.06%。前两个不优于 SenseVoice；Fun-ASR-Nano 是 LLM 架构（SenseVoice 编码器 + Qwen3-0.6B 解码器），sherpa-onnx 的 int8 包 802 MB，和 Qwen3-ASR 同一类体积。

**结论：在「扩展进程内、不用起服务」这个前提下，当时没有比 SenseVoice 更准的中文模型。** 唯一实测更准的仍是 Qwen3-ASR-1.7B（4.3%），代价是要起服务。

**→ 这条结论在 2026-09-15 被推翻：`fun-asr-nano` 进程内跑出难中文 5.0%、耳语 6.3%，且运行时换成原生插件后不再受 WASM 内存限制。见第 11 节。**

复现：

```bash
cd extensions/dictation
# 下载解压到 ~/.pi/agent/dictation-models/<id>/，加一条 catalog 目录，然后：
PI_DICTATION_CONFIG=/tmp/cfg.json ./dev.ts transcribe test/fixtures/raokouling.wav
# 与 test/fixtures/README.md 里的标准答案对比（去标点、阿拉伯数字转中文、算字错率）
```

复现：

```bash
cd extensions/dictation
npm test                                   # 目录/家族一致性
PI_DICTATION_CONFIG=/tmp/cfg.json ./dev.ts transcribe test/fixtures/raokouling.wav
./scripts/qwen3-asr-server.py --model Qwen/Qwen3-ASR-1.7B   # 然后用 openai-compatible 指过去
```

---

## 11. 耳语（whispered speech）实测（2026-09-15，本机）

### 11.1 为什么耳语是另一类问题

耳语时声带不振动，于是没有基频、低频能量低、谱质心上移。对只在正常语音上训过的模型来说，这不只是「小声」，而是**分布外输入**——韵母的线索没有了。

判断一段录音是不是耳语，用这三个量就够了（`scripts/whisper-probe.py`）：

| 录音 | 浊音帧占比 | <300 Hz 能量占比 | 谱质心 |
|---|---|---|---|
| 八百标兵奔北坡（正常） | 35.8% | 32.8% | 570 Hz |
| 吃葡萄不吐葡萄皮（正常） | 34.8% | 75.5% | 252 Hz |
| 哪个小型语音…（耳语） | **3.3%** | **13.8%** | **1250 Hz** |
| 我没有找到一个…（耳语） | **14.8%** | **11.1%** | **1235 Hz** |

耳语：浊音帧占比接近 0、300 Hz 以下能量接近 0、谱质心明显更高。

### 11.2 第三方数据（不是本机，只作方向参考）

来源：AmphionASR 技术报告 Table 15。中文耳语测试集 wEar，所有系统统一 greedy 解码、不给耳语专用提示、不做音频预处理。

| 模型 | 中文耳语 CER |
|---|---|
| AmphionASR 1.7B | 0.58%（**未开源，只有论文**） |
| FireRed-ASR2-**LLM** | 1.01% |
| Qwen3-ASR-1.7B | 1.22% |
| Fun-ASR-Nano | 2.75% |
| GLM-ASR-nano | 15.41% |
| Whisper-large-v3 | 16.33% |

两条要点：

1. 榜上的 FireRed-ASR2-**LLM** 和我们内置的 FireRedASR2-**CTC** 不是一个分支；CTC 分支在普通话上已被本机实测证明更差（§10.1），不要拿它代表 FireRed 家族。
2. **Whisper 系和 GLM-ASR-Nano 在中文耳语上和中文小模型是一个量级（15–16%）**，不是候选。GLM 的模型卡专门写了 “Low-Volume Speech Robustness”，但独立数据不支持这一点。

### 11.3 本机实测

原始转录与复算脚本已存进仓库：`docs/asr-eval-2026-09-15/`（五个模型的逐字输出 + 参考文本）、`scripts/asr-cer.py`（打分）。下表每个数字都能用那两样东西重算。

三份音频、五个模型，同一个 CER 口径（去标点、去空格、阿拉伯数字转中文）。耳语平均 = whisper-1 与 whisper-2 合并计算。

| 模型 | raokouling（140 字，正常语音） | 耳语 whisper-1（20 字） | 耳语 whisper-2（43 字） | 耳语平均 |
|---|---|---|---|---|
| `fun-asr-nano` | 5.0%（7） | 15.0%（3） | **2.3%（1）** | **6.3%** |
| `qwen3-asr` 1.7B（本机服务） | **4.3%（6）** | 15.0%（3） | **2.3%（1）** | **6.3%** |
| `x-asr-480ms-zh-en-punct` | 14.3%（20） | 40.0%（8） | 11.6%（5） | 20.6% |
| `sense-voice-small` | 7.9%（11） | 45.0%（9） | 16.3%（7） | 25.4% |
| `fire-red-asr2-ctc-zh-en` | 10.7%（15） | 55.0%（11） | 18.6%（8） | 30.2% |

这组数字是在**原生运行时**上跑的（见 11.6）。在此之前用 WASM 运行时跑过同一批：结果只差一两个字（`sense-voice-small` 在 raokouling 上 8.6% → 7.9%，`fire-red-asr2-ctc` 在 whisper-2 上 11.6% → 18.6%），**`fun-asr-nano` 的逐字输出完全一样**。原因是线程数不同 → 浮点归约顺序不同 → 个别 logits 微差，贪心解码偶尔选中另一个字。属于噪声级别，不是准确率变化。

whisper-2 的逐字对照，失败模式看这一行就够：

```text
参考        我没有找到一个在低语中表现良好的模型。如果你推荐一个，请描述一下你使用它处理低语文本的经验

fun-asr-nano 我没有找到一个在低语中表现良好的模型但如果你推荐一个请描述一下你使用它处理低语文本的经验
qwen3-asr    我没有找到一个在低语中表现良好的模型，但如果你推荐一个，请描述一下你使用它处理低语文本的经验。
sense-voice  我没有找到一个在地域中表现良好的母西，但如果你推荐一个请描述一下你使用它处理地域文本的经验。
x-asr        我没有找到一个在地狱中表现良好的模型， 但如果你推荐一个请描述一下你使用它处理地域文本的经验
fire-red-ctc 我没有找到一个在地狱中表现良好的默但如果你推荐一个请描述一下你使用它处理地语文本的经验
```

三个中文小模型都把「低语」听成「地域 / 地狱 / 地语」。丢的不是音量，是韵母——所以调麦克风增益没有用。

f1 上 `fun-asr-nano` 和 `qwen3-asr` 的输出逐字相同（都把「转文本」听成「转文字」、都漏掉「识别」），whisper-2 上两者只差标点。

### 11.4 结论

1. **耳语不需要自己训练模型**，换模型就行。
2. **本机最优解是 `fun-asr-nano`**：耳语 6.3%（与 Qwen3-ASR-1.7B 并列），难中文 5.0%，而且**进程内运行、不需要服务器、不需要 GPU、不需要开机启动**。
3. `qwen3-asr` 只在难中文上略胜（4.3% 对 5.0%），代价是常驻约 8.5 GB 内存的独立服务（`scripts/qwen3-asr-server.py`）。
4. 比它更好的都拿不到：FireRed-ASR2-LLM（1.01%）要 8B 级 GPU，AmphionASR（0.58%）没有开源代码和权重。
5. 想自己训（wEar 中文真实耳语 18 小时、AISHELL6-Whisper 30 小时）在 6.3% 已经可用的前提下不划算。

### 11.5 `fun-asr-nano` 的两个实现坑

1. **这个导出是用 `max_total_len=512` 转换的**（音频帧 + 输出 token 共用一个预算）。超长输入**不崩**，而是打印警告并返回**空字符串**——静默失败。实测：20.76 秒的 fixture 完整解出；25 秒截断；30 秒以上返回空。`local/catalog.ts` 已设 `maxSeconds: 25`，把静默失败变成明确报错。需要更长的单段输入，得换 `max_total_len` 更大的重导出：<https://modelscope.cn/models/zengshuishui/FunASR-nano-onnx/>。
2. **（历史）WASM 构建器读 `config.tokens` 时没有 `|| ''` 兜底**（streaming 构建器有），不传就抛 `Cannot read properties of undefined (reading 'length')`。这个家族没有 token 表，所以当时要显式传空串。**换成原生运行时后不再需要**，那行已删（原生实测：传与不传都是 140 字）。

### 11.6 速度：换成原生运行时之后

同一台机器、同一份 20.76 秒音频（raokouling），benchmark 只计识别器创建与解码：

| 运行时 | 线程 | 识别器加载 | 解码 | 解码 RTF |
|---|---|---|---|---|
| WASM（改造前） | 1（只能 1） | 1.98 s | 16.9 s | 0.81 |
| **原生插件 `sherpa-onnx-node`（现在用的）** | 4 | 2.39 s | 4.26 s | **0.21** |

`sense-voice-small` 在同一份音频上：WASM 0.10 → 原生 **0.04**。

走扩展完整路径（含 node 启动）的墙钟时间：

| 音频长度 | `fun-asr-nano` | `sense-voice-small` |
|---|---|---|
| 5.9 s | 3.1 s | 0.7 s |
| 11.0 s | 3.7 s | 0.8 s |
| 20.8 s | 6.9 s | 0.9 s |

为什么之前慢：

1. **WASM 运行时根本不支持多线程。** sherpa-onnx 自己会打印 `WASM does not support multi-threading. Changing num_threads from 8 to 1.`，所以调大 `numThreads` 完全无效。这是主因：`fun-asr-nano` 的 0.6B 解码器要逐字自回归生成，而 SenseVoice 是一次 CTC 前向。
2. 换原生插件后解码快约 4 倍，而且仍然是进程内、不需要服务器。线程数是 `min(4, 核数 - 1)`；4 线程后收益就饱和了（8 线程只从 0.21 降到 0.19）。
3. 代价：引入平台相关二进制（`sherpa-onnx-linux-x64` 等，由 npm 按平台选装），不再是「零原生编译」。

### 11.7 复现

```bash
cd extensions/dictation

# 判断一段录音是不是耳语
python3 scripts/whisper-probe.py <音频...>

# 本地模型（含 fun-asr-nano）
PI_DICTATION_CONFIG=/tmp/cfg.json ./dev.ts transcribe <音频> --json

# 本机服务做对照
./scripts/qwen3-asr-server.py --model Qwen/Qwen3-ASR-1.7B

# 第 11.3 节那张表怎么重算（原始转录在 docs/asr-eval-2026-09-15/）
for s in raokouling whisper-1 whisper-2; do \
  python3 scripts/asr-cer.py docs/asr-eval-2026-09-15/reference.$s.txt docs/asr-eval-2026-09-15/*.$s.txt; \
done
```

---

## 12. 后续怎么用这份文件

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

要真正下结论，原本需要补齐三件事，现在已做掉两件（见第 10 节）：

1. ~~在本机用同一段录音跑 SenseVoice / FireRedASR2-CTC，记录 RTF、错字、内存。~~ 已完成。
2. ~~用现成的 `openai-compatible` 通道接一个自建或云端服务，做同样对比。~~ 已完成（Qwen3-ASR 本机服务、智谱 GLM 云端）。
3. 定一个「够用」的标准（比如：日常听写错字率低于某个值就行），否则永远在选型。**还缺这一条。**
