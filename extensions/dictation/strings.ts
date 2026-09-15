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
    timedOut: (seconds: number) => string;
  };
  error: {
    noKey: (provider: string, env: string) => string;
    noProvider: string;
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
    /** How the two model kinds behave, shown in the model list. */
    kind: { offline: string; streaming: string };
    /** Marks the model `providers.local.model` points at — even when it is not downloaded, the config still is. */
    active: string;
    notDownloaded: string;
    /** The list's last line: how to switch models. */
    switchHint: (command: string) => string;
    /** After the user switches model: what changed, and when it applies. */
    switched: (id: string, detail: string, configPath: string) => string;
  };
  command: {
    description: string;
    usage: string;
    modeSet: (mode: string) => string;
    /** The current key mode, printed when a switch command gets no argument. */
    modeCurrent: (mode: string) => string;
    status: (state: string, provider: string, keybind: string, mode: string, configPath: string) => string;
    providerSet: (id: string) => string;
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
    timedOut: (seconds) => `录音已达上限 ${seconds} 秒，自动停止`,
  },
  error: {
    noKey: (provider, env) => `语音服务 ${provider} 缺少 API Key：请设置环境变量 ${env}，或在 ~/.pi/agent/dictation.json 里填写 apiKey`,
    noProvider: "没有可用的语音服务。可以 1) 下载本地模型：/dictation model download；2) 配置云端 Key。用 /dictation doctor 查看详情",
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
    kind: { offline: "说完再出字", streaming: "边说边出字" },
    active: "← 当前配置",
    notDownloaded: "未下载",
    switchHint: (command) => `切换：${command} model use <id>（未下载的先 ${command} model download <id>）`,
    switched: (id, detail, configPath) =>
      `本地模型已切到 ${id}${detail ? ` · ${detail}` : ""}\n下一次录音生效（已保存到 ${configPath}）`,
  },
  command: {
    description: "语音输入：录音、识别、模型与服务管理",
    usage: "用法：/dictation [start|stop|send|cancel|status|provider <name>|model [download|use|delete|path] [id]|mode [hold|toggle]|test [秒数]|doctor|mic|config]",
    modeSet: (mode) => `按键模式已切换为 ${mode}（已保存，下一次录音生效）`,
    modeCurrent: (mode) => `当前按键模式：${mode}（切换：mode hold|toggle）`,
    status: (state, provider, keybind, mode, configPath) => `状态 ${state} · 服务 ${provider} · 快捷键 ${keybind} · 模式 ${mode} · 配置 ${configPath}`,
    providerSet: (id) => `语音服务已切换为 ${id}`,
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
    timedOut: (seconds) => `Reached the ${seconds}s limit — stopping automatically`,
  },
  error: {
    noKey: (provider, env) => `${provider} needs an API key: set ${env}, or put apiKey in ~/.pi/agent/dictation.json`,
    noProvider: "No usable speech service. Either 1) download the local model: /dictation model download, or 2) configure a cloud key. Run /dictation doctor for details",
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
    kind: { offline: "text after you stop", streaming: "live text while you speak" },
    active: "← configured",
    notDownloaded: "not downloaded",
    switchHint: (command) => `switch: ${command} model use <id> (download first: ${command} model download <id>)`,
    switched: (id, detail, configPath) =>
      `switched to ${id}${detail ? ` · ${detail}` : ""}\neffective on the next recording (saved to ${configPath})`,
  },
  command: {
    description: "Voice input: record, transcribe, manage models and services",
    usage: "Usage: /dictation [start|stop|send|cancel|status|provider <name>|model [download|use|delete|path] [id]|mode [hold|toggle]|test [seconds]|doctor|mic|config]",
    modeSet: (mode) => `Key mode switched to ${mode} (saved; applies to the next recording)`,
    modeCurrent: (mode) => `Key mode: ${mode} (switch with: mode hold|toggle)`,
    status: (state, provider, keybind, mode, configPath) => `state ${state} · service ${provider} · keybind ${keybind} · mode ${mode} · config ${configPath}`,
    providerSet: (id) => `Speech service switched to ${id}`,
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
