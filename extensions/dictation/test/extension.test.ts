/**
 * Extension wiring test: drives the real `dictationExtension` factory with a
 * fake pi host, a fake editor, and a fake microphone tool, then presses the
 * hotkey twice.
 *
 * This is the test that catches "the shortcut does nothing": it asserts the
 * shortcut is registered and reachable, that the first press starts recording
 * (level meter shown), and that the second press transcribes and inserts the
 * text at the cursor.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

const FAKE_FFMPEG = `#!/usr/bin/env node
const data = Buffer.alloc(32000 * 2);
for (let i = 0; i < 32000; i += 1) data.writeInt16LE(6000, i * 2);
process.stdout.write(data);
process.on("SIGINT", () => process.exit(0));
setInterval(() => {}, 200);
`;

const CONFIG = {
  locale: "zh",
  keybind: "ctrl+r",
  keybindMode: "hold",
  provider: "localserver",
  providers: {
    localserver: { type: "openai-compatible", endpoint: "http://127.0.0.1:9/v1/audio/transcriptions", model: "whisper-1" },
  },
  capture: { tool: "ffmpeg", minBytes: 64 },
  output: { appendTrailingSpace: true, submitOnStop: false, replacements: { 你好世界: "你好，世界" } },
};

type Harness = {
  ctx: ExtensionContext;
  ui: {
    theme: Theme;
    notifications: Array<{ message: string; type: string }>;
    widgets: Map<string, string[] | undefined>;
    statuses: Map<string, string | undefined>;
    editorText: string;
    inserted: string[];
  };
  shortcuts: Map<string, (ctx: ExtensionContext) => Promise<void> | void>;
  commands: Map<
    string,
    {
      handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
    }
  >;
  tools: Set<string>;
  installedEditor: EditorComponent | undefined;
  pressRawKey(data: string): void;
  setCursor(cursor: { line: number; col: number } | undefined): void;
  hasRawHandler(): boolean;
  runCommand(name: string, args?: string): Promise<void>;
  restore(): void;
};

const harness = async (config: Record<string, unknown> = CONFIG): Promise<Harness> => {
  const binDir = mkdtempSync(join(tmpdir(), "pi-dictation-bin-"));
  const tool = join(binDir, "ffmpeg");
  writeFileSync(tool, FAKE_FFMPEG);
  chmodSync(tool, 0o755);

  const workDir = mkdtempSync(join(tmpdir(), "pi-dictation-test-"));
  const configPath = join(workDir, "dictation.json");
  writeFileSync(configPath, JSON.stringify({ ...config, capture: { ffmpegPath: tool, ...(config.capture as object) } }));

  const previousEnv = { ...process.env };
  const modelsDir = mkdtempSync(join(tmpdir(), "pi-dictation-models-"));
  Object.assign(process.env, { PI_DICTATION_CONFIG: configPath, PI_DICTATION_MODELS_DIR: modelsDir, PATH: `${binDir}:${previousEnv.PATH ?? ""}` });
  // Tests must never reach the network. A developer's real key would make a
  // cloud provider "ready", so a fake recording would become a real API call —
  // and the assertions below would depend on which keys happen to be exported.
  // Individual tests that need a key set it themselves, after this point.
  for (const name of Object.keys(process.env)) {
    if (/_API_KEY$/.test(name)) delete process.env[name];
  }

  const shortcuts = new Map<string, (ctx: ExtensionContext) => Promise<void> | void>();
  const commands = new Map<
    string,
    {
      handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
    }
  >();
  const tools = new Set<string>();
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();

  const ui = {
    theme: { fg: (_color: string, text: string) => text, borderColor: (text: string) => text } as unknown as Theme,
    notifications: [] as Array<{ message: string; type: string }>,
    widgets: new Map<string, string[] | undefined>(),
    statuses: new Map<string, string | undefined>(),
    editorText: "",
    inserted: [] as string[],
  };

  let installedEditor: EditorComponent | undefined;
  let rawInputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  // undefined = "caret at the end", which is what the other tests assume.
  let cursor: { line: number; col: number } | undefined;

  const fakeBase = {
    focused: true,
    getText: () => ui.editorText,
    getCursor: () => cursor,
    setText: (text: string) => {
      ui.editorText = text;
    },
    getExpandedText: () => ui.editorText,
    render: () => ["[prompt]"],
    handleInput: () => {},
    insertTextAtCursor: (text: string) => {
      ui.inserted.push(text);
      ui.editorText += text;
    },
    invalidate: () => {},
  } as unknown as EditorComponent;

  const ctx = {
    hasUI: true,
    ui: {
      theme: ui.theme,
      notify: (message: string, type = "info") => ui.notifications.push({ message, type }),
      setWidget: (key: string, content: string[] | undefined) => ui.widgets.set(key, content),
      setStatus: (key: string, text: string | undefined) => ui.statuses.set(key, text),
      getEditorText: () => ui.editorText,
      setEditorText: (text: string) => {
        ui.editorText = text;
      },
      setEditorComponent: (factory: (tui: unknown, theme: unknown, keybindings: unknown) => EditorComponent) => {
        installedEditor = factory({ requestRender: () => {} }, {}, {});
      },
      onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
        rawInputHandler = handler;
        return () => {
          rawInputHandler = undefined;
        };
      },
      // Pretend pi already installed a plain editor, so the wrapper layers on
      // top of it and no real CustomEditor/TUI is constructed in tests.
      getEditorComponent: () => () => fakeBase,
    },
    isIdle: () => true,
  } as unknown as ExtensionContext;

  const pi = {
    registerShortcut: (shortcut: string, options: { handler: (ctx: ExtensionContext) => Promise<void> | void }) => {
      shortcuts.set(shortcut, options.handler);
    },
    registerCommand: (
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
        getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
      },
    ) => {
      commands.set(name, options);
    },
    registerTool: (toolDefinition: { name: string }) => {
      tools.add(toolDefinition.name);
    },
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;

  const { default: dictationExtension, setEditorHelpers } = await import("../index.ts");
  // The test process has no pi packages, so inject the TUI helpers the
  // extension would otherwise load from pi itself.
  setEditorHelpers({
    matchesKey: (data: string, key: string) =>
      data === key || (key === "ctrl+r" && (data === "\u0012" || data.startsWith("\u001b[114;5"))),
    isKeyRepeat: (data: string) => data.endsWith(":2u"),
    isKeyRelease: (data: string) => data.endsWith(":3u"),
    visibleWidth: (text: string) => [...text].length,
    truncateToWidth: (text: string, width: number) => [...text].slice(0, width).join(""),
    createBase: () => fakeBase,
  });
  await dictationExtension(pi);
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);

  return {
    ctx,
    ui,
    shortcuts,
    commands,
    tools,
    get installedEditor() {
      return installedEditor;
    },
    pressRawKey(data: string) {
      rawInputHandler?.(data);
    },
    setCursor(value: { line: number; col: number } | undefined) {
      cursor = value;
    },
    hasRawHandler() {
      return Boolean(rawInputHandler);
    },
    async runCommand(name: string, args = "") {
      const command = commands.get(name);
      if (!command) throw new Error(`command "${name}" is not registered`);
      await command.handler(args, ctx);
    },
    restore: () => {
      process.env = previousEnv;
    },
  } as Harness;
};

const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for: ${message}`);
};

/**
 * A press only counts as a new press once the previous burst has closed. On a
 * terminal that reports no key release that is the auto-repeat gap: 800 ms for
 * the first burst, 300 ms (not the 800) once repeats are arriving. Sleep past
 * it before expecting a second toggle to register.
 */
const nextPressDelay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 950));

test("the /dictation model list marks the model in use and names the switch command", async () => {
  const h = await harness();
  try {
    await h.runCommand("dictation", "model");
    const message = h.ui.notifications.at(-1)?.message ?? "";
    // The list is the only place that says how to switch, so name what it must contain.
    // (This harness points at an empty models dir, so every model reads as not downloaded.
    // The active marker says "配置": the model is what the config points at, not
    // a promise that it is usable right now.)
    assert.match(message, /[✓✗] sense-voice-small ← 当前配置\n\s+[^·]+ · 说完再出字 · 未下载 ≈\d+ MB/);
    assert.match(message, /✗ x-asr-480ms-zh-en-punct\n\s+[^·]+ · 边说边出字 · 未下载 ≈\d+ MB/);
    assert.match(message, /切换：\/dictation model use <id>/);
    assert.match(message, /未下载的先 \/dictation model download <id>/);
  } finally {
    h.restore();
  }
});

test("the /dictation argument completion walks action → argument", async () => {
  const h = await harness();
  try {
    const complete = h.commands.get("dictation")?.getArgumentCompletions;
    assert.ok(complete, "the command exposes argument completions");
    const values = (prefix: string) => (complete(prefix) ?? []).map((item) => item.value);

    assert.deepEqual(values("mo"), ["model", "mode"]);
    assert.deepEqual(values("model "), ["model use", "model download", "model delete", "model path"]);
    assert.ok(values("model use ").includes("model use sense-voice-small"), "the model ids come from the catalog");
    assert.ok(
      values("model use sense-voice-small").includes("model use sense-voice-small"),
      "a half-typed id still completes to the whole argument",
    );
    assert.ok(values("model use sense").includes("model use sense-voice-small"));
    assert.deepEqual(values("mode "), ["mode hold", "mode toggle"]);
    assert.ok(values("provider ").includes("provider localserver"), "provider ids come from the config, plus auto");
    assert.deepEqual(complete("nonsense "), null, "an unknown action proposes nothing");
  } finally {
    h.restore();
  }
});

test("registers the command, the tool, the editor wrapper and the raw key handler", async () => {
  const h = await harness();
  try {
    assert.ok(h.commands.has("dictation"), `commands: ${[...h.commands].join(", ")}`);
    assert.ok(h.tools.has("transcribe_audio"), `tools: ${[...h.tools].join(", ")}`);
    assert.ok(h.installedEditor, "the editor wrapper is installed at session start");
    // ctrl+r is deliberately NOT registered via pi.registerShortcut: that would
    // shadow pi's own `app.session.rename` and print a conflict note on start.
    assert.equal(h.shortcuts.size, 0, "no app-level shortcut is registered");
    assert.ok(h.hasRawHandler(), "the raw terminal input handler is installed instead");
  } finally {
    h.restore();
  }
});

test("the hotkey records, transcribes and inserts at the cursor", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ text: "你好世界" }), { status: 200 })) as typeof fetch;

  const h = await harness({ ...CONFIG, keybindMode: "toggle" });
  try {
    h.pressRawKey("\u0012");
    assert.equal(h.ui.widgets.get("dictation")?.length, 1, "recording shows the level meter widget");
    assert.ok(
      h.ui.notifications.some((n) => n.message.includes("录音中")),
      `expected a recording toast, got: ${h.ui.notifications.map((n) => n.message).join(" | ")}`,
    );

    await nextPressDelay();
    h.pressRawKey("\u0012");
    await waitFor(() => h.ui.inserted.length > 0, "second press transcribes and inserts");

    assert.deepEqual(h.ui.inserted, ["你好，世界 "], "transcript inserted at cursor, replacements applied, trailing space kept");
    assert.equal(h.ui.widgets.get("dictation"), undefined, "widget cleared after recording");
    assert.equal(h.ui.statuses.get("dictation-model"), undefined);
    assert.ok(
      h.ui.notifications.some((n) => n.message.includes("已插入")),
      `expected an inserted toast, got: ${h.ui.notifications.map((n) => n.message).join(" | ")}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    h.restore();
  }
});

test("a transcript dropped inside a word is padded on both sides", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ text: "hello" }), { status: 200 })) as typeof fetch;

  const h = await harness({ ...CONFIG, keybindMode: "toggle", output: { appendTrailingSpace: true, submitOnStop: false, replacements: {} } });
  try {
    h.ui.editorText = "helloworld";
    h.setCursor({ line: 0, col: 5 });
    h.pressRawKey("\u0012");
    await nextPressDelay();
    h.pressRawKey("\u0012");
    await waitFor(() => h.ui.inserted.length > 0, "second press transcribes and inserts");

    // Both neighbours are ASCII word characters, so the transcript is separated
    // on both sides — and the configured trailing space is not doubled.
    assert.deepEqual(h.ui.inserted, [" hello "]);
  } finally {
    globalThis.fetch = originalFetch;
    h.restore();
  }
});

test("a raw ctrl+r keystroke is consumed and toggles recording", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ text: "raw key" }), { status: 200 })) as typeof fetch;

  const h = await harness({ ...CONFIG, keybindMode: "toggle" });
  try {
    h.pressRawKey("\u0012");
    assert.equal(h.ui.widgets.get("dictation")?.length, 1, "raw ctrl+r starts recording");

    await nextPressDelay();
    h.pressRawKey("\u0012");
    await waitFor(() => h.ui.inserted.length > 0, "raw ctrl+r again stops and inserts");
    assert.deepEqual(h.ui.inserted, ["raw key "]);
  } finally {
    globalThis.fetch = originalFetch;
    h.restore();
  }
});

test("hold mode records while held and finishes on key release", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ text: "hold" }), { status: 200 })) as typeof fetch;

  const h = await harness();
  try {
    h.pressRawKey("\u001b[114;5u");
    assert.equal(h.ui.widgets.get("dictation")?.length, 1, "press starts recording");
    assert.ok(h.ui.widgets.get("dictation")?.[0]?.includes("松开结束"), "the meter shows the hold hint");

    // Give the fake microphone a moment to stream audio, then hold the key:
    // auto-repeat events must not stop the recording.
    await new Promise((resolve) => setTimeout(resolve, 250));
    h.pressRawKey("\u001b[114;5:2u");
    h.pressRawKey("\u001b[114;5:2u");
    assert.equal(h.ui.widgets.get("dictation")?.length, 1, "key repeat is ignored");

    h.pressRawKey("\u001b[114;5:3u");
    await waitFor(() => h.ui.inserted.length > 0, "release stops and inserts");
    assert.deepEqual(h.ui.inserted, ["hold "]);
  } finally {
    globalThis.fetch = originalFetch;
    h.restore();
  }
});

test("hold mode ends by itself when the terminal sends no key release", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ text: "legacy" }), { status: 200 })) as typeof fetch;

  const h = await harness();
  try {
    h.pressRawKey("\u0012"); // legacy terminal: press only, no release event
    assert.equal(h.ui.widgets.get("dictation")?.length, 1, "press starts recording");

    // Auto-repeat is indistinguishable from a new press here, so it must keep
    // the recording alive instead of stopping it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    h.pressRawKey("\u0012");
    assert.equal(h.ui.widgets.get("dictation")?.length, 1, "a repeat does not stop the recording");

    // The repeats stop (the key went up): the gap ends the recording.
    await waitFor(() => h.ui.inserted.length > 0, "the gap after the last repeat stops the recording");
    assert.deepEqual(h.ui.inserted, ["legacy "]);
  } finally {
    globalThis.fetch = originalFetch;
    h.restore();
  }
});

test("toggle mode ignores the auto-repeat of a held key: one press toggles once", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ text: "held" }), { status: 200 })) as typeof fetch;

  const h = await harness({ ...CONFIG, keybindMode: "toggle" });
  try {
    h.pressRawKey("\u0012"); // press
    h.pressRawKey("\u0012"); // auto-repeat: same physical press, no release in between
    h.pressRawKey("\u0012");
    assert.equal(h.ui.widgets.get("dictation")?.length, 1, "the repeat burst does not toggle the recording off");

    await nextPressDelay(); // the key goes up; the burst closes
    h.pressRawKey("\u0012");
    await waitFor(() => h.ui.inserted.length > 0, "a real second press stops the recording");
    assert.deepEqual(h.ui.inserted, ["held "]);
  } finally {
    globalThis.fetch = originalFetch;
    h.restore();
  }
});

test("/dictation mode switches the key mode and saves it", async () => {
  const h = await harness({ ...CONFIG, keybindMode: "toggle" });
  try {
    await h.runCommand("dictation", "mode hold");
    assert.ok(
      h.ui.notifications.some((n) => n.message.includes("按键模式已切换为 hold")),
      `expected a mode toast, got: ${h.ui.notifications.map((n) => n.message).join(" | ")}`,
    );
    const saved = JSON.parse(readFileSync(process.env.PI_DICTATION_CONFIG as string, "utf8"));
    assert.equal(saved.keybindMode, "hold", "the new mode is written to the config file");
  } finally {
    h.restore();
  }
});

test("/dictation mode rejects anything but hold or toggle", async () => {
  const h = await harness();
  try {
    await h.runCommand("dictation", "mode sideways");
    const last = h.ui.notifications.at(-1);
    assert.equal(last?.type, "error", `expected an error, got: ${JSON.stringify(last)}`);
    assert.match(last?.message ?? "", /mode \[hold\|toggle\]/, "the message names the accepted values");
  } finally {
    h.restore();
  }
});

test("a hotkey press with nothing configured reports an actionable error", async () => {
  const h = await harness({ keybind: "ctrl+r", providers: { openai: { type: "openai-compatible", endpoint: "https://api.test/v1/audio/transcriptions", model: "whisper-1", apiKeyEnv: "PI_DICTATION_TEST_MISSING" } } });
  try {
    h.pressRawKey("\u0012");
    await waitFor(() => h.ui.notifications.some((n) => n.type === "error"), "actionable error shown");
    assert.ok(
      h.ui.notifications.some((n) => n.type === "error" && /语音服务|speech service/.test(n.message)),
      `expected an actionable error, got: ${JSON.stringify(h.ui.notifications)}`,
    );
    assert.equal(h.ui.widgets.get("dictation"), undefined, "no widget when recording never started");
  } finally {
    h.restore();
  }
});
