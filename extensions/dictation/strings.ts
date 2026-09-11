/**
 * All user-visible text, in one place per locale.
 * The product name is never localized. Default locale is `zh`.
 */

import type { Locale } from "./config.ts";

export type Strings = {
  product: string;
  indicator: {
    idle: string;
    recording: string;
    transcribing: string;
    /** Label of the live (streaming) transcript line. */
    live: string;
    /** Stop hint for toggle mode. */
    recordingHint: string;
    /** Stop hint for hold mode. */
    holdHint: string;
    cancelHint: string;
    sendHint: string;
  };
  toast: {
    recording: (keybind: string, stopHint: string) => string;
    transcribing: string;
    inserted: (chars: number) => string;
    sent: (chars: number) => string;
    cancelled: string;
    noSpeech: string;
    tooShort: string;
    stillBusy: string;
    /** Shown once when the terminal does not report key releases. */
    holdUnsupported: string;
    timedOut: (seconds: number) => string;
  };
  error: {
    noKey: (provider: string, env: string) => string;
    noProvider: string;
    noModel: (id: string) => string;
    unknownProvider: (id: string, known: string) => string;
    notRecording: string;
    alreadyRecording: string;
    silenceHint: string;
    generic: (detail: string) => string;
  };
  model: {
    missing: (id: string, mb: number) => string;
    downloading: (id: string, mb: number) => string;
    progress: (percent: number, doneMb: number, totalMb: number) => string;
    extracting: string;
    ready: (id: string) => string;
    deleted: (id: string) => string;
    failed: (detail: string) => string;
  };
  command: {
    description: string;
    usage: string;
    status: (state: string, provider: string, keybind: string, configPath: string) => string;
    providerSet: (id: string) => string;
    modelSet: (id: string) => string;
    providerList: (lines: string) => string;
    testStarted: (seconds: number) => string;
    testResult: (text: string) => string;
    testEmpty: string;
    fileMissing: (path: string) => string;
  };
  doctor: {
    title: string;
    ok: string;
    warn: string;
    fail: string;
    recorder: (tool: string, detail: string) => string;
    model: (id: string, state: string) => string;
    provider: (id: string, state: string) => string;
    summary: (ok: boolean) => string;
  };
};

const zh: Strings = {
  product: "Pi Dictation",
  indicator: {
    idle: "语音",
    recording: "录音中",
    transcribing: "识别中",
    live: "实时",
    recordingHint: "再按结束",
    holdHint: "松开结束",
    cancelHint: "取消",
    sendHint: "发送",
  },
  toast: {
    recording: (keybind, stopHint) => `录音中 · ${keybind} ${stopHint} · Enter 发送 · Esc 取消`,
    transcribing: "正在识别语音…",
    inserted: (chars) => `已插入 ${chars} 个字符，按 Enter 发送`,
    sent: (chars) => `已发送 ${chars} 个字符`,
    cancelled: "已取消录音",
    noSpeech: "没有识别到语音，请靠近麦克风重试",
    tooShort: "录音太短或没有声音，请检查麦克风设备",
    stillBusy: "上一条语音还在识别中，请稍候",
    holdUnsupported: "这个终端（或 tmux）不上报按键松开，已改为「按一下开始、再按一下结束」。想用长按：在真正的 ghostty 窗口里直接跑 pi（不要经过 tmux），或用 pi-dictation keytest 确认",
    timedOut: (seconds) => `录音已达上限 ${seconds} 秒，自动停止`,
  },
  error: {
    noKey: (provider, env) => `语音服务 ${provider} 缺少 API Key：请设置环境变量 ${env}，或在 ~/.pi/agent/dictation.json 里填写 apiKey`,
    noProvider: "没有可用的语音服务。可以 1) 下载本地模型：/dictation model download；2) 配置云端 Key。用 /dictation doctor 查看详情",
    noModel: (id) => `本地语音模型未下载。运行 /dictation model download 下载（约 155 MB，一次即可）`,
    unknownProvider: (id, known) => `未知的语音服务 "${id}"。可用：${known}`,
    notRecording: "当前没有在录音",
    alreadyRecording: "正在录音或识别中",
    silenceHint: "录音是静音：请检查系统麦克风权限和默认输入设备（capture.device）",
    generic: (detail) => `语音处理失败：${detail}`,
  },
  model: {
    missing: (id, mb) => `本地模型 ${id} 未下载（约 ${mb} MB，压缩包）`,
    downloading: (id, mb) => `开始下载本地模型 ${id}（约 ${mb} MB）…`,
    progress: (percent, doneMb, totalMb) => `下载中 ${percent}%（${doneMb}/${totalMb} MB）`,
    extracting: "正在解压模型…",
    ready: (id) => `本地模型 ${id} 已就绪`,
    deleted: (id) => `已删除本地模型 ${id}`,
    failed: (detail) => `模型操作失败：${detail}`,
  },
  command: {
    description: "语音输入：录音、识别、模型与服务管理",
    usage: "用法：/dictation [start|stop|send|cancel|status|provider <name>|model [download|use|delete|path] [id]|test [秒数]|doctor|mic|config]",
    status: (state, provider, keybind, configPath) => `状态 ${state} · 服务 ${provider} · 快捷键 ${keybind} · 配置 ${configPath}`,
    providerSet: (id) => `语音服务已切换为 ${id}`,
    modelSet: (id) => `本地模型已切换为 ${id}（只对本次会话有效。要保留：把 providers.local.model 写进 ~/.pi/agent/dictation.json）`,
    providerList: (lines) => `语音服务：\n${lines}`,
    testStarted: (seconds) => `测试录音 ${seconds} 秒，识别结果只显示不插入`,
    testResult: (text) => `识别结果：${text}`,
    testEmpty: "测试识别结果为空",
    fileMissing: (path) => `文件不存在：${path}`,
  },
  doctor: {
    title: "语音自检",
    ok: "正常",
    warn: "注意",
    fail: "失败",
    recorder: (tool, detail) => `录音工具 ${tool}：${detail}`,
    model: (id, state) => `本地模型 ${id}：${state}`,
    provider: (id, state) => `语音服务 ${id}：${state}`,
    summary: (ok) => (ok ? "可以开始语音输入了。" : "还有问题未解决，请看上面的失败项。"),
  },
};

const en: Strings = {
  product: "Pi Dictation",
  indicator: {
    idle: "dictation",
    recording: "recording",
    transcribing: "transcribing",
    live: "live",
    recordingHint: "press again to stop",
    holdHint: "release to finish",
    cancelHint: "cancel",
    sendHint: "send",
  },
  toast: {
    recording: (keybind, stopHint) => `Recording · ${keybind} ${stopHint} · Enter send · Esc cancel`,
    transcribing: "Transcribing…",
    inserted: (chars) => `Inserted ${chars} characters — press Enter to send`,
    sent: (chars) => `Sent ${chars} characters`,
    cancelled: "Recording cancelled",
    noSpeech: "No speech detected — try again closer to the microphone",
    tooShort: "Recording too short or silent — check the microphone device",
    stillBusy: "Still transcribing the previous recording",
    holdUnsupported: "This terminal (or tmux) does not report key releases — using press-to-start / press-to-stop instead. For hold-to-talk, run pi directly in ghostty (not through tmux), or check with `pi-dictation keytest`",
    timedOut: (seconds) => `Reached the ${seconds}s limit — stopping automatically`,
  },
  error: {
    noKey: (provider, env) => `${provider} needs an API key: set ${env}, or put apiKey in ~/.pi/agent/dictation.json`,
    noProvider: "No usable speech service. Either 1) download the local model: /dictation model download, or 2) configure a cloud key. Run /dictation doctor for details",
    noModel: (id) => `Local model ${id} is not downloaded. Run /dictation model download (~155 MB, one time)`,
    unknownProvider: (id, known) => `Unknown speech service "${id}". Available: ${known}`,
    notRecording: "Not recording right now",
    alreadyRecording: "Already recording or transcribing",
    silenceHint: "Recording is silent: check microphone permission and the default input device (capture.device)",
    generic: (detail) => `Voice processing failed: ${detail}`,
  },
  model: {
    missing: (id, mb) => `Local model ${id} not downloaded (~${mb} MB archive)`,
    downloading: (id, mb) => `Downloading local model ${id} (~${mb} MB)…`,
    progress: (percent, doneMb, totalMb) => `Downloading ${percent}% (${doneMb}/${totalMb} MB)`,
    extracting: "Extracting model…",
    ready: (id) => `Local model ${id} is ready`,
    deleted: (id) => `Deleted local model ${id}`,
    failed: (detail) => `Model operation failed: ${detail}`,
  },
  command: {
    description: "Voice input: record, transcribe, manage models and services",
    usage: "Usage: /dictation [start|stop|send|cancel|status|provider <name>|model [download|use|delete|path] [id]|test [seconds]|doctor|mic|config]",
    status: (state, provider, keybind, configPath) => `state ${state} · service ${provider} · keybind ${keybind} · config ${configPath}`,
    providerSet: (id) => `Speech service switched to ${id}`,
    modelSet: (id) => `Local model switched to ${id} (this session only — to keep it, set providers.local.model in ~/.pi/agent/dictation.json)`,
    providerList: (lines) => `Speech services:\n${lines}`,
    testStarted: (seconds) => `Test recording for ${seconds}s — the transcript is shown, not inserted`,
    testResult: (text) => `Transcript: ${text}`,
    testEmpty: "Test transcript is empty",
    fileMissing: (path) => `File not found: ${path}`,
  },
  doctor: {
    title: "Voice doctor",
    ok: "ok",
    warn: "warn",
    fail: "fail",
    recorder: (tool, detail) => `Recorder ${tool}: ${detail}`,
    model: (id, state) => `Local model ${id}: ${state}`,
    provider: (id, state) => `Speech service ${id}: ${state}`,
    summary: (ok) => (ok ? "Ready for dictation." : "Unresolved items above."),
  },
};

export const resolveStrings = (locale: Locale): Strings => (locale === "en" ? en : zh);
