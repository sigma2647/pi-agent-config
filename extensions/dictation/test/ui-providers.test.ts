import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Theme } from "../ui.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import { resolveStrings } from "../strings.ts";
import { createOpenAiCompatibleProvider } from "../providers/openai-compatible.ts";
import { applyLiveDraft, createDictationEditorFactory, cursorOffset, editorCursorOffset, formatClock, injectRightLabel, insertAtEditorCursor, keepTail, offsetCursor, renderBars, renderIndicator, renderLiveText, renderWidget, replaceEditorRange, unwrapEditor, type EditorHelpers } from "../ui.ts";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const strings = resolveStrings("zh");
const base = { theme, strings, keybind: "ctrl+r", stopHint: strings.indicator.holdHint };

/** Width maths without pi-tui: good enough to test the label placement. */
const helpers: EditorHelpers = {
  matchesKey: () => false,
  isKeyRepeat: () => false,
  isKeyRelease: () => false,
  visibleWidth: (text) => [...text].length,
  truncateToWidth: (text, width) => [...text].slice(0, width).join(""),
  createBase: () => {
    throw new Error("not used in tests");
  },
};

test("formatClock renders m:ss", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(4000), "0:04");
  assert.equal(formatClock(65_000), "1:05");
  assert.equal(formatClock(-5), "0:00");
});

test("renderBars always fills the requested width", () => {
  assert.equal([...renderBars([], 8)].length, 8);
  assert.equal([...renderBars([32768], 3)].length, 3);
  assert.ok(renderBars([32768], 1).includes("█"));
  assert.equal(renderBars([0], 1), "▁");
});

test("renderIndicator shows state and hotkey", () => {
  const idle = renderIndicator({ ...base, state: "idle" });
  assert.ok(idle.includes("ctrl+r"));

  const recording = renderIndicator({ ...base, state: "recording", levels: [32768], elapsedMs: 3000 });
  assert.ok(recording.includes("录音中"));
  assert.ok(recording.includes("0:03"));

  const transcribing = renderIndicator({ ...base, state: "transcribing" });
  assert.ok(transcribing.includes("识别中"));
});

test("renderWidget shows the elapsed and maximum time plus the keys", () => {
  const widget = renderWidget({ ...base, levels: [0], elapsedMs: 2000, maxMs: 120_000 });
  assert.ok(widget.includes("0:02 / 2:00"));
  assert.ok(widget.includes("⏎"));
  assert.ok(widget.includes("⎋"));
});

test("renderLiveText labels the partial transcript and keeps the newest words", () => {
  const text = "你好世界这是一段很长的实时文字";
  const line = renderLiveText({ theme, strings, text, width: 14, measure: helpers.visibleWidth });
  assert.ok(line.startsWith(`${strings.indicator.live} `), `expected the label first, got ${line}`);
  assert.ok(line.endsWith("实时文字"), `the newest words stay visible, got ${line}`);
  assert.ok(!line.includes("你好"), "the oldest words are the ones dropped");
  assert.ok(keepTail("abcdef", 3, helpers.visibleWidth) === "def");
  assert.equal(keepTail("abc", 0, helpers.visibleWidth), "");
});

test("keepTail counts terminal columns, not code points", () => {
  // Whatever pi-tui reports as the width is what the tail must fit into.
  const wide = (value: string) => [...value].reduce((total, char) => total + (char.codePointAt(0)! > 0x1100 ? 2 : 1), 0);
  const kept = keepTail("中文字符测试", 5, wide);
  assert.ok(wide(kept) <= 5, `${JSON.stringify(kept)} must fit in 5 columns`);
  assert.ok(kept.endsWith("试"));
});

test("cursorOffset / offsetCursor round-trip across lines", () => {
  const text = "ab\ncd";
  assert.equal(cursorOffset(text, { line: 0, col: 2 }), 2);
  assert.equal(cursorOffset(text, { line: 1, col: 1 }), 4);
  assert.deepEqual(offsetCursor(text, 2), { line: 0, col: 2 });
  assert.deepEqual(offsetCursor(text, 4), { line: 1, col: 1 });
});

const fakeBuffer = (text: string, col: number) => {
  const state = { lines: [text], cursorLine: 0, cursorCol: col };
  return {
    state,
    getText: () => state.lines.join("\n"),
    setText: (next: string) => {
      throw new Error(`setText should not run (${next})`);
    },
  };
};

test("applyLiveDraft grows in place while the caret stays in the live span", () => {
  const editor = fakeBuffer("hello world", 11);
  const draft = { origin: -1, lastLive: "", ignored: "" };
  applyLiveDraft(editor, draft, "你好");
  assert.equal(editor.state.lines[0], "hello world你好");
  applyLiveDraft(editor, draft, "你好世界");
  assert.equal(editor.state.lines[0], "hello world你好世界");
  assert.equal(draft.origin, 11);
});

test("applyLiveDraft inserts only new words at the caret after the user moves away", () => {
  const editor = fakeBuffer("hello world", 11);
  const draft = { origin: -1, lastLive: "", ignored: "" };
  applyLiveDraft(editor, draft, "你好");
  editor.state.cursorCol = 5;
  applyLiveDraft(editor, draft, "你好世界");
  assert.equal(editor.state.lines[0], "hello世界 world你好");
  assert.equal(draft.origin, 5);
  assert.equal(draft.lastLive, "世界");
});

test("applyLiveDraft inserts at a click inside the live span instead of yanking to the end", () => {
  const editor = fakeBuffer("", 0);
  const draft = { origin: -1, lastLive: "", ignored: "" };
  applyLiveDraft(editor, draft, "现在开始输入。");
  assert.equal(editor.state.cursorCol, "现在开始输入。".length);

  editor.state.cursorCol = 0;
  applyLiveDraft(editor, draft, "现在开始输入。继续");
  assert.equal(editor.state.lines[0], "继续现在开始输入。");
  assert.equal(editor.state.cursorCol, 2);
});

test("applyLiveDraft does not restore text the user cleared with Ctrl+U", () => {
  const editor = fakeBuffer("", 0);
  const draft = { origin: -1, lastLive: "", ignored: "" };
  editor.state.lines[0] = "keep ";
  editor.state.cursorCol = 5;
  applyLiveDraft(editor, draft, "你好");
  assert.equal(editor.state.lines[0], "keep 你好");

  editor.state.lines[0] = "";
  editor.state.cursorCol = 0;
  applyLiveDraft(editor, draft, "你好世界");
  assert.equal(editor.state.lines[0], "世界");
  assert.equal(draft.ignored, "你好");
});

test("insertAtEditorCursor splices at state.cursorCol, not at the end", () => {
  const state = { lines: ["hello world"], cursorLine: 0, cursorCol: 5 };
  const editor = {
    state,
    getText: () => state.lines.join("\n"),
    setText: (text: string) => {
      throw new Error(`setText should not run (${text})`);
    },
  };
  const origin = insertAtEditorCursor(editor, "X");
  assert.equal(origin, 5);
  assert.equal(state.lines[0], "helloX world");
  assert.equal(state.cursorCol, 6);
});

test("unwrapEditor walks nested .base to the innermost editor", () => {
  const inner = { state: { lines: ["ab"], cursorLine: 0, cursorCol: 1 } };
  const outer = { base: { base: inner } };
  assert.equal(unwrapEditor(outer), inner);
});

test("replaceEditorRange splices in the middle without rewriting the whole suffix", () => {
  const state = { lines: ["hello world"], cursorLine: 0, cursorCol: 5 };
  const editor = {
    state,
    getText: () => state.lines.join("\n"),
    setText: (text: string) => {
      throw new Error(`setText should not run (${text})`);
    },
  };
  const next = replaceEditorRange(editor, 6, 0, "there ");
  assert.equal(next, "hello there world");
  assert.deepEqual(state.lines, ["hello there world"]);
  assert.equal(editorCursorOffset(editor), 5);
});

test("the editor wrapper exposes getCursor so live insert is not stuck at the end", () => {
  const fake = {
    getText: () => "hello world",
    setText: () => {},
    render: () => ["hello world"],
    handleInput: () => {},
    getCursor: () => ({ line: 0, col: 5 }),
    borderColor: (value: string) => value,
  };
  let ready: { getCursor?: () => { line: number; col: number } } | undefined;
  const factory = createDictationEditorFactory(() => fake as never, {
    keybind: "ctrl+r",
    helpers,
    getState: () => "idle",
    getTheme: () => theme,
    getContext: () => ({}) as never,
    onToggle: () => {},
    onCancel: () => {},
    onSend: () => {},
    renderLabel: () => "",
    onEditorReady: (component) => {
      ready = component;
    },
  });
  const ed = factory({} as never, {} as never, {} as never) as { getCursor: () => { line: number; col: number } };
  assert.deepEqual(ed.getCursor(), { line: 0, col: 5 });
  assert.deepEqual(ready?.getCursor?.(), { line: 0, col: 5 });
});

test("injectRightLabel right-aligns inside the width", () => {
  const line = "[".padEnd(40, "-");
  const injected = injectRightLabel(line, 40, "label", helpers);
  assert.equal([...injected].length, 40);
  assert.ok(injected.endsWith("label"));
});

test("injectRightLabel truncates a label wider than the line", () => {
  assert.equal(injectRightLabel("abc", 3, "a-very-long-label", helpers), "a-v");
});

test("injectRightLabel returns an empty line for zero width", () => {
  assert.equal(injectRightLabel("abc", 0, "label", helpers), "");
});

test("openai-compatible provider posts multipart audio and reads the text field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-audio-"));
  const audioPath = join(dir, "recording.wav");
  writeFileSync(audioPath, "RIFFfake audio payload");

  const originalFetch = globalThis.fetch;
  let seen: Request | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = new Request(input as string, init);
    return new Response(JSON.stringify({ text: "  你好，世界  " }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const provider = createOpenAiCompatibleProvider(
      "local-server",
      { type: "openai-compatible", endpoint: "http://127.0.0.1:10301/v1/audio/transcriptions", model: "whisper-1" },
      {} as NodeJS.ProcessEnv,
    );
    const result = await provider.transcribe({ audioPath, language: "zh", signal: AbortSignal.timeout(5000) });
    assert.equal(result.text, "你好，世界");
    assert.equal(seen?.headers.get("authorization"), null, "loopback needs no key");
    const body = (await seen?.formData())!;
    assert.equal(body.get("model"), "whisper-1");
    assert.equal(body.get("language"), "zh");
    assert.ok(body.get("file"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible provider refuses an insecure remote endpoint", async () => {
  const provider = createOpenAiCompatibleProvider(
    "insecure",
    { type: "openai-compatible", endpoint: "http://api.example.test/v1/audio/transcriptions", model: "whisper-1" },
    {} as NodeJS.ProcessEnv,
  );
  await assert.rejects(() => provider.transcribe({ audioPath: "/tmp/none.wav", signal: AbortSignal.timeout(100) }), /HTTPS/);
});

test("openai-compatible provider reports a missing key before sending", async () => {
  const provider = createOpenAiCompatibleProvider(
    "openai",
    { type: "openai-compatible", endpoint: "https://api.test/v1/audio/transcriptions", model: "whisper-1", apiKeyEnv: "OPENAI_API_KEY" },
    {} as NodeJS.ProcessEnv,
  );
  await assert.rejects(() => provider.transcribe({ audioPath: "/tmp/none.wav", signal: AbortSignal.timeout(100) }), /missing API key/);
});

test("openai-compatible provider explains an authentication failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-audio-401-"));
  const audioPath = join(dir, "recording.wav");
  writeFileSync(audioPath, "RIFFfake");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("invalid api key", { status: 401 })) as typeof fetch;
  try {
    const provider = createOpenAiCompatibleProvider(
      "openai",
      { type: "openai-compatible", endpoint: "https://api.test/v1/audio/transcriptions", model: "whisper-1", apiKeyEnv: "OPENAI_API_KEY" },
      { OPENAI_API_KEY: "sk-wrong" } as NodeJS.ProcessEnv,
    );
    await assert.rejects(() => provider.transcribe({ audioPath, signal: AbortSignal.timeout(5000) }), /authentication failed \(401\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible provider fails when the response has no text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-audio-empty-"));
  const audioPath = join(dir, "recording.wav");
  writeFileSync(audioPath, "RIFFfake");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
  try {
    const provider = createOpenAiCompatibleProvider(
      "local-server",
      { type: "openai-compatible", endpoint: "http://127.0.0.1:10301/v1/audio/transcriptions", model: "whisper-1" },
      {} as NodeJS.ProcessEnv,
    );
    await assert.rejects(() => provider.transcribe({ audioPath, signal: AbortSignal.timeout(5000) }), /no text/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("default config is discoverable and sane", () => {
  assert.equal(DEFAULT_CONFIG.provider, "auto");
  assert.equal(DEFAULT_CONFIG.capture.sampleRate, 16000);
  assert.ok(DEFAULT_CONFIG.providers.local);
});
