# pi-dictation — 语音输入（本地模型 / 云端 API）

按 `ctrl+r` 开始说话，说完再按一次，文字就插到光标处。默认优先用**本地 SenseVoice 模型**（离线、免费、不用密钥）；没有本地模型时自动用云端 API。

插到已有文字中间时会自动补空格（`hello` + 听写 + `world` 不会粘成 `helloworld`）；中文字之间不加空格。这条只在「说完再出字」（含云端）时生效：流式模型是边说边把字写在光标处，不做补空格。

```
ctrl+r          开始 / 结束（默认 toggle 模式）
Enter（录音中）  立刻结束 → 识别 → 直接发送
Esc（录音中）    取消，不留文字
/dictation ...   状态、切换服务、下载模型、测麦克风、自检
```

录制时：输入框边框变红，右上角显示 `● 录音中 ▁▃▅▇ 0:04`，输入框上方显示**实时音量条 + 已录时长 / 上限**。识别时边框变黄。

若本地模型选的是流式模型（`x-asr-480ms-zh-en-punct`），字从**当前光标处**写进输入框。见[流式模型](#流式模型边说边出字)。

按键模式由 `keybindMode` 决定：

| 值 | 行为 | 说明 |
|---|---|---|
| `toggle`（默认） | 按一下开始，再按一下结束 | 任何终端都可用 |
| `hold` | 按住说话，松开结束 | 需要终端上报「按键松开」事件（Kitty 键盘协议）。ghostty 直接跑 pi 可以；**经过 tmux / herdr 等复用器时松开事件会被吞掉**。不支持时第一次「再按一下」会自动降级为 `toggle` 并提示一次 |

两种模式都忽略**按住不放产生的重复按键**，所以长按不会误停。

想确认自己的终端属于哪种：在**终端里直接**运行

```bash
pi-dictation keytest        # 按几次 ctrl+r（含一次按住再松开），它会告诉你是否收到松开事件
```

## 组成

| 文件 | 作用 |
|---|---|
| `index.ts` | pi 扩展入口：快捷键、`/dictation` 命令、`transcribe_audio` 工具 |
| `dev.ts` | `pi-dictation` 命令行（录音 / 转写文件 / 模型管理 / 自检） |
| `core.ts` | 两个入口共用的流程与决策，避免两边逻辑漂移 |
| `config.ts` | 配置读写与合并（单一来源） |
| `audio.ts` | 麦克风录制（ffmpeg / pw-record / arecord / sox，统一推 raw PCM 到 stdout） |
| `wav.ts` | PCM 解析：峰值、音量、时长 |
| `mic.ts` | 麦克风诊断：列输入设备、采样测电平、解释「静音」 |
| `providers/` | 语音服务：`openai-compatible`、`deepgram` |
| `local/` | 本地模型：`catalog.ts` 模型清单、`model.ts` 下载/删除、`sherpa.ts` 运行时、`provider.ts` 离线识别、`streaming.ts` 边说边出字 |
| `ui.ts` | 边框标签、音量条、按键拦截 |
| `keyprobe.ts` | 解码终端按键事件（判断是否支持「松开」），供 `pi-dictation keytest` 用 |

新增一个云端服务：写 `providers/<名字>.ts`，在 `providers/index.ts` 的 `createProvider` 加一个分支即可，其他文件不用改。

## 安装与依赖

```bash
npm install --prefix extensions/dictation   # 依赖 sherpa-onnx (WASM，约 15 MB)、类型检查用的 devDependencies
cd ~/pi-agent-config && just install      # 链接 pi-dictation 到 ~/.local/bin
```

`npm run check` 用 `tsconfig.json` 做类型检查。devDependencies 里的 pi 类型包只给检查用：运行时这些模块由 pi 自己提供（它会把 `@earendil-works/*` 和 `typebox` 指向自带的副本），所以本地那几份不会被加载。

模型文件在、但 `sherpa-onnx` 没装时，`/dictation doctor`、`/dictation status` 和转写报错都会写明修复命令，不会等到录完音才失败。

录制的后端需要一个：`ffmpeg`（推荐）、`pw-record`、`arecord` 或 `sox`。模型下载/解压需要系统 `tar` 和 `bzip2`。

## 本地模型（离线）

内置两个模型，同一时间用一个（`providers.local.model`）：

| id | 特点 | 大小 | 速度 |
|---|---|---|---|
| `sense-voice-small`（默认） | 中英日韩粤，自带标点，识别完再出结果 | 155 MB | 约 0.1 RTF |
| `x-asr-480ms-zh-en-punct` | 中英，**边说边出字**，自带标点 | 127 MB | 约 0.1 RTF，第一批字 0.2 秒 |

```bash
/dictation model                          # 查看模型状态（会标出哪个在用、怎么切换）
/dictation model download                 # 下载 SenseVoice Small（约 155 MB，解压后约 385 MB）
/dictation model download x-asr-480ms-zh-en-punct   # 下载流式模型
/dictation model use x-asr-480ms-zh-en-punct        # 切到流式模型
/dictation model delete                   # 删除模型与压缩包
/dictation model path                     # 打印模型目录
```

命令行里同样的操作：`pi-dictation model`（列出并标出当前模型）、`pi-dictation model use <id>`、`pi-dictation model download <id>`。两个入口的 `model use` 都会写回 `dictation.json`，重启 pi 后仍生效。

- 目录：`~/.pi/agent/dictation-models/<模型 id>/`（可用 `PI_DICTATION_MODELS_DIR` 改）。
- 语言：SenseVoice 支持 中文 / English / 日本語 / 한국어 / 粤语，自动识别；流式模型支持中英混合。
- 速度：约 0.1 RTF（10 秒录音约 1 秒识别，首次会多 ~0.5 秒加载模型）。
- 内存：模型常驻约 500 MB，进程退出才释放。离线模型是 WASM，无原生编译、无联网。

### 流式模型：边说边出字

选 `x-asr-480ms-zh-en-punct` 后，录音时识别出的字**从当前光标处写进输入框**（ASR 改词就替换这一段）。光标默认跟在新字后面。方向键或鼠标把光标从这段活字末尾挪开后，已写出的字留在原地，只有新说的字插到新光标；Ctrl+U 清空后已删的字不会写回。Esc 只停止录音，已写入的字全部留下。没有 TUI 时（`/dictation test`）仍画在输入框上方的「实时」行。

- 流式模型比 SenseVoice 略不准（同一个词可能听错），换来的是即时反馈。二者都是约 0.1 RTF。
- 内存：流式模型加载后常驻约 400 MB（实测 RSS，SenseVoice 约 500 MB），进程退出才释放。
- 用**流式模型**转写文件时，文件会被当成一段很长的录音送进同一个识别器，结果和实时听写一致。
- `/dictation model use` / `pi-dictation model use` / `/dictation provider` 会写回 `dictation.json`。
- `/dictation test 5` 也会显示实时文字，但结果只显示、不插入。

## 云端服务

`providers` 里内置 5 个条目，`provider: "auto"` 时按 `local → openai → groq → siliconflow → deepgram` 取第一个就绪的：

| id | 类型 | 默认模型 | 需要的环境变量 |
|---|---|---|---|
| `local` | 本地模型 | SenseVoice Small | 无 |
| `openai` | OpenAI 兼容 | `whisper-1` | `OPENAI_API_KEY` |
| `groq` | OpenAI 兼容 | `whisper-large-v3-turbo` | `GROQ_API_KEY` |
| `siliconflow` | OpenAI 兼容 | `FunAudioLLM/SenseVoiceSmall` | `SILICONFLOW_API_KEY` |
| `deepgram` | Deepgram | `nova-3` | `DEEPGRAM_API_KEY` |

任何 OpenAI 兼容的语音接口（含本机 whisper.cpp / faster-whisper / sherpa-onnx server）都可以加一条：

```json
{
  "providers": {
    "my-server": {
      "type": "openai-compatible",
      "endpoint": "http://127.0.0.1:10301/v1/audio/transcriptions",
      "model": "whisper-1"
    }
  }
}
```

规则：`https` 必须；`http` 只允许 localhost，且 localhost 不发送密钥。密钥可以写 `apiKeyEnv`（环境变量名）或 `apiKey`（明文，输出时会被隐藏）。

短于 0.3 秒的录音（误触）不发给云端：本地就能量出长度、断定里面不可能有内容，直接跳过，省一次请求和等待。这条只对能测量的 PCM16 WAV 生效，mp3 等格式照常上传。

## 配置

文件：`~/.pi/agent/dictation.json`（首次运行自动生成；也可用 `PI_DICTATION_CONFIG` 指定）。环境变量覆盖：`PI_DICTATION_PROVIDER`、`PI_DICTATION_KEYBIND`、`PI_DICTATION_LOCALE`、`PI_DICTATION_MODELS_DIR`、`PI_DICTATION_TIMEOUT_MS`。

```json
{
  "locale": "zh",
  "keybind": "ctrl+r",
  "keybindMode": "hold",
  "provider": "auto",
  "providers": {
    "local": { "type": "local", "model": "sense-voice-small", "language": "auto" }
  },
  "capture": {
    "tool": "auto",
    "device": "",
    "ffmpegPath": "ffmpeg",
    "sampleRate": 16000,
    "channels": 1,
    "maxSeconds": 120,
    "minBytes": 512
  },
  "output": {
    "appendTrailingSpace": true,
    "submitOnStop": false,
    "replacements": { "配志": "配置" }
  }
}
```

- `output.submitOnStop`：`true` 时，第二次按快捷键就是「停止并发送」。
- `output.replacements`：识别结果里的固定错词替换（大小写不敏感；含中文时不做词边界限制）。
- `capture.device`：`auto`/空＝默认设备；Linux 用 PulseAudio 源名，macOS 用 `:0`/`:1`，Windows 用设备名或 `default`。
- `locale`：`zh`（默认）或 `en`。修改 `keybind`/`locale` 后需要 `/reload` 或重启 pi。
- `keybindMode` 默认 `hold`（按住说话）；改成 `toggle` 就是按一下开始、再按一下结束。
- `keybind` 默认 `ctrl+r`（与 pi 内置的「重命名会话」冲突，本扩展优先；想消掉启动提示见下文排查表）。

## 在 pi 里

```
/dictation                状态（当前服务、就绪情况）
/dictation provider       列出所有服务；/dictation provider local 切换
/dictation model          列出本地模型（标出当前用的那个 + 切换命令）
/dictation model use <id> 切换本地模型（如 x-asr-480ms-zh-en-punct 边说边出字）
/dictation model download 下载本地模型
/dictation test 5         录 5 秒，只显示识别结果、不插入
/dictation doctor         自检（录音工具、服务、密钥、模型、配置路径）
/dictation config         打印配置（密钥已隐藏）
```

`transcribe_audio` 工具让 agent 可以转写任意音频文件（本地模型读 WAV，采样率不限，会自动重采样；其它格式先用 `ffmpeg -i in.mp3 -ar 16000 -ac 1 out.wav` 转换）。

## 命令行

```bash
pi-dictation transcribe <file> [--provider local] [--language zh] [--json]
pi-dictation record [--seconds 10]        # 回车提前结束
pi-dictation model [status|download|use|delete|path]
pi-dictation providers
pi-dictation doctor
pi-dictation config
```

## 排查

| 现象 | 处理 |
|---|---|
| `没有可用的语音服务` | `/dictation doctor` 看每一行的原因；下载本地模型或设置云端密钥 |
| `recording is silent (peak 0)` | 麦克风在给「数字静音」。先跑 `pi-dictation mic`：它会告诉你默认输入是哪个、其它输入有哪些、怎么切。典型原因：无线麦发射端没开、默认设备选错、显示器/声卡的 monitor 源 |
| 没有反应 | 确认存在 `ffmpeg`/`pw-record`/`arecord`/`sox` 之一：`pi-dictation doctor` |
| `ctrl+r` 和「重命名会话」冲突 | 已处理：本扩展不再注册 app 级快捷键，而是在按键到达编辑器之前就接住 `ctrl+r`，所以启动时不会再有冲突提示；代价是 `ctrl+r` 不再触发改名（改名仍可在 `/tree`/会话选择器里做） |
| 模型下载失败 | 需要网络与 `tar`+`bzip2`；代理走 `HTTPS_PROXY`（`pi-dictation` 由 curl 下载，会读取该变量） |
| 识别很慢 | 本地模型是单线程 WASM；可切云端服务：`/dictation provider groq` |

已知取舍：sherpa-onnx 的 C 层日志会写到 stdout，正常情况下静默；如果它打印内容，TUI 可能重绘一次。`numThreads` 固定为 1（WASM 单线程）。

## 测试

```bash
npm --prefix extensions/dictation test        # 80 个测试：WAV/配置/服务/录制器/UI/模型/按键解码/麦克风诊断
PI_DICTATION_LOCAL_TEST=1 npm --prefix extensions/dictation test   # 含真实模型转写（需要已下载模型）
```

录制器测试用一个假的 ffmpeg 脚本（向 stdout 推 PCM）验证：SIGINT 收尾、实时计时、实时电平、WAV 头回填、太短拒收、静音拒收、取消清理。
接线测试用一个假的 pi 宿主验证：ctrl+r 按下/重复/松开、降级逻辑、识别后插入光标处。
