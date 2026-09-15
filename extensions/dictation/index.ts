/**
 * Voice input for pi — offline (SenseVoice) or cloud (OpenAI-compatible,
 * Deepgram) dictation into the prompt.
 *
 * Surfaces:
 *   - hotkey (default ctrl+r): start / stop recording
 *   - Enter while recording: stop and send;  Esc: stop recording (keep the text)
 *   - `/dictation ...`: status, provider switch, model download, doctor, test
 *   - `transcribe_audio` tool: transcribe an audio file (used by the agent)
 *
 * Shared logic lives in core.ts so the `pi-dictation` CLI behaves the same.
 */

import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, EditorComponent, KeyId, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createRecorder, detectRecorderTool, type RecordHandle } from "./audio.ts";
import {
  defaultConfigPath,
  ensureConfigFile,
  isKeybindMode,
  KEYBIND_MODES,
  loadConfig,
  redactConfig,
  saveConfig,
  type DictationConfig,
} from "./config.ts";
import { applyReplacements, describeLocalModels, describeModelSwitch, doctorReport, formatTranscript, localModelRows, micDiagnostics, notReadyHint, setLocalModel, transcribeFile } from "./core.ts";
import { DEFAULT_LOCAL_MODEL, isStreamingModel, knownModelIds, localModelSpec } from "./local/catalog.ts";
import { deleteModel, downloadModel, modelState } from "./local/model.ts";
import { createStreamingSession, loadStreamingRecognizer, type StreamingSession } from "./local/streaming.ts";
import { providerStatuses, resolveProvider } from "./providers/index.ts";
import { resolveStrings, type Strings } from "./strings.ts";
import {
  applyLiveDraft,
  createDictationEditorFactory,
  offsetCursor,
  padAtCaret,
  placeEditorCursor,
  renderIndicator,
  renderLiveText,
  renderWidget,
  replaceEditorRange,
  unwrapEditor,
  type BaseEditorFactory,
  type EditorBuffer,
  type EditorHelpers,
  type DictationState,
  type LiveDraft,
} from "./ui.ts";
import { pcmLevels } from "./wav.ts";

const TICK_MS = 120;
const METER_SLICES = 24;
const METER_SLICE_MS = 20;
const TAIL_BYTES = Math.round((16000 * 2 * METER_SLICES * METER_SLICE_MS) / 1000);
const TOGGLE_DEBOUNCE_MS = 400;
/**
 * Release detection for terminals that never report a key release (no kitty
 * keyboard protocol): the only proof that the key is still down is the stream
 * of auto-repeat events, so a gap in that stream means the user let go.
 *
 * The first window must outlast the terminal's auto-repeat delay — 500 ms on
 * most systems, 660 ms on stock X11 — or a held key would read as released
 * before its first repeat arrives. Later repeats use the short window: they
 * arrive every few dozen milliseconds, so a 300 ms gap is already a release.
 */
const GAP_FIRST_MS = 800;
const GAP_REPEAT_MS = 300;

type FinishMode = "insert" | "send" | "test";

/**
 * pi-tui helpers and the base editor are loaded from pi itself, so this module
 * (and the CLI) stay free of TUI imports at load time. `setEditorHelpers` lets
 * tests inject stubs instead (the test process has no pi packages).
 */
let editorHelpers: EditorHelpers | undefined;

export const setEditorHelpers = (helpers: EditorHelpers): void => {
  editorHelpers = helpers;
};

const loadEditorHelpers = async (): Promise<EditorHelpers> => {
  const [tui, pi] = await Promise.all([import("@earendil-works/pi-tui"), import("@earendil-works/pi-coding-agent")]);
  return {
    matchesKey: (data: string, key: string) => tui.matchesKey(data, key as KeyId),
    isKeyRepeat: (data: string) => tui.isKeyRepeat(data),
    isKeyRelease: (data: string) => tui.isKeyRelease(data),
    truncateToWidth: (text: string, width: number, ellipsis = "") => tui.truncateToWidth(text, width, ellipsis),
    visibleWidth: (text: string) => tui.visibleWidth(text),
    createBase: (editorTui: TUI, theme, keybindings: KeybindingsManager) => new pi.CustomEditor(editorTui, theme, keybindings),
  };
};

export default async function dictationExtension(pi: ExtensionAPI) {
  // Preload the TUI helpers before any session starts, so the editor wrapper is
  // installed synchronously in session_start (no race with pi creating its editor).
  if (!editorHelpers) {
    try {
      editorHelpers = await loadEditorHelpers();
    } catch (error) {
      console.warn(`pi-dictation: TUI helpers unavailable (${errorText(error)}); border label and level meter are disabled.`);
    }
  }

  let config: DictationConfig = loadConfig();
  let strings: Strings = resolveStrings(config.locale);
  let state: DictationState = "idle";
  let lastError: string | undefined;
  let handle: RecordHandle | undefined;
  /** Live decoder, when the selected local model is a streaming one. */
  let live: StreamingSession | undefined;
  let editor: EditorComponent | undefined;
  let tui: TUI | undefined;
  let sessionCtx: ExtensionContext | undefined;
  let rawInputCleanup: (() => void) | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let lastToggle = 0;
  /** True while the hotkey is down, as far as the press/repeat stream can tell. */
  let keyDown = false;
  let gapTimer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  /** Live prompt insert: prefix/suffix around the caret at record start. */
  let draft: LiveDraft | undefined;

  const notify = (ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error" = "info"): void => {
    // The product name owns its own line: it is a label, not the first item of the
    // message, and multi-line lists (models, providers) read as a block under it.
    if (ctx?.hasUI) ctx.ui.notify(`${strings.product}:\n${message}`, type);
    else if (type === "error") console.error(`${strings.product}: ${message}`);
  };

  /** The "nothing is ready" toast plus the one-line real cause (missing runtime, missing key, …). */
  const noProviderMessage = (): string => `${strings.error.noProvider}\n${notReadyHint(config, process.env)}`;

  const currentLevels = (): number[] =>
    handle ? pcmLevels(handle.readTail(TAIL_BYTES), METER_SLICES, METER_SLICE_MS, config.capture.sampleRate) : [];

  const bufferOf = (): EditorBuffer | undefined => (editor ? unwrapEditor(editor) : undefined);
  const moveCursor = (text: string, offset: number): void => {
    const buffer = bufferOf();
    if (!buffer) return;
    const { line, col } = offsetCursor(text, offset);
    placeEditorCursor(buffer, line, col);
  };
  const paintDraft = (_ctx: ExtensionContext, live: string): void => {
    if (!draft) return;
    const buffer = bufferOf();
    if (buffer) applyLiveDraft(buffer, draft, live);
  };
  const abandonDraft = (_ctx: ExtensionContext): void => {
    if (!draft) return;
    const buffer = bufferOf();
    if (buffer && draft.origin >= 0 && draft.lastLive) {
      const next = replaceEditorRange(buffer, draft.origin, draft.lastLive.length, "");
      moveCursor(next, draft.origin);
    }
    draft = undefined;
  };

  /** The streaming model in use right now, if the selected provider is a local one. */
  const streamingModelId = (): string | undefined => {
    const resolved = resolveProvider(config);
    if (!resolved || resolved.config.type !== "local") return undefined;
    return isStreamingModel(resolved.config.model) ? resolved.config.model : undefined;
  };

  const refresh = (ctx?: ExtensionContext): void => {
    if (state === "recording" && handle && ctx?.hasUI) {
      const liveText = live?.step() ?? "";
      const lines = [
        renderWidget({
          theme: ctx.ui.theme,
          levels: currentLevels(),
          elapsedMs: handle.elapsedMs(),
          maxMs: config.capture.maxSeconds * 1000,
          keybind: config.keybind,
          stopHint: stopHint(),
          strings,
        }),
      ];
      // Insert at the caret. setText would yank the cursor to the end.
      if (draft && liveText) {
        paintDraft(ctx, applyReplacements(liveText, config.output.replacements).trim());
      } else if (liveText) {
        lines.push(
          renderLiveText({
            theme: ctx.ui.theme,
            text: liveText,
            strings,
            width: tui?.terminal?.columns,
            measure: editorHelpers?.visibleWidth,
          }),
        );
      }
      ctx.ui.setWidget("dictation", lines);
    } else if (ctx?.hasUI) {
      ctx.ui.setWidget("dictation", undefined);
    }
    tui?.requestRender();
  };

  const setState = (next: DictationState, ctx?: ExtensionContext): void => {
    state = next;
    refresh(ctx ?? sessionCtx);
  };

  /**
   * True while a recording is live. Read through a call on purpose: `state` and
   * `handle` change inside other functions (a cancel during an await), so a
   * direct comparison would be narrowed to a stale value by the compiler — and
   * would keep being stale at runtime too.
   */
  const stillRecording = (): boolean => state === "recording" && handle !== undefined;

  const stopTicker = (): void => {
    if (ticker) clearInterval(ticker);
    if (deadline) clearTimeout(deadline);
    ticker = undefined;
    deadline = undefined;
  };

  /** Live meter + automatic stop. `test` mode never inserts into the prompt. */
  const startTicker = (ctx: ExtensionContext, testSeconds: number): void => {
    stopTicker();
    ticker = setInterval(() => refresh(ctx), TICK_MS);
    ticker.unref?.();
    const seconds = testSeconds > 0 ? testSeconds : config.capture.maxSeconds;
    deadline = setTimeout(() => {
      if (testSeconds > 0) void finishRecording(ctx, "test");
      else void finishRecording(ctx, config.output.submitOnStop ? "send" : "insert", { timedOut: true });
    }, seconds * 1000);
    deadline.unref?.();
  };

  const startRecording = async (ctx: ExtensionContext, testSeconds = 0): Promise<void> => {
    if (state !== "idle" || busy) {
      notify(ctx, strings.error.alreadyRecording, "warning");
      return;
    }
    try {
      config = loadConfig();
      strings = resolveStrings(config.locale);
      const resolved = resolveProvider(config);
      if (!resolved) {
        notify(ctx, noProviderMessage(), "error");
        return;
      }

      // Streaming models decode while the user speaks. The recorder starts
      // first and its audio is buffered until the model is loaded, so the
      // first press never loses the first words.
      const modelId = streamingModelId();
      const buffered: Buffer[] = [];
      handle = createRecorder(
        config.capture,
        modelId ? { onPcm: (chunk) => (live ? live.push(chunk) : buffered.push(chunk)) } : {},
      ).start();
      sessionCtx = ctx;
      lastError = undefined;
      draft = testSeconds > 0 || !modelId ? undefined : { origin: -1, lastLive: "", ignored: "" };
      setState("recording", ctx);
      startTicker(ctx, testSeconds);
      refresh(ctx);
      notify(ctx, testSeconds > 0 ? strings.command.testStarted(testSeconds) : strings.toast.recording(config.keybind, stopHint()));

      if (modelId) {
        const session = await createStreamingSession(modelId, config.capture.sampleRate);
        if (!stillRecording()) {
          session.free();
          return;
        }
        for (const chunk of buffered) session.push(chunk);
        buffered.length = 0;
        live = session;
      }
    } catch (error) {
      lastError = errorText(error);
      notify(ctx, lastError, "error");
      live?.free();
      live = undefined;
      abandonDraft(ctx);
      await abortHandle();
      setState("idle", ctx);
    }
  };

  const finishRecording = async (ctx: ExtensionContext, mode: FinishMode, options: { timedOut?: boolean } = {}): Promise<void> => {
    if (state !== "recording" || !handle || busy) return;
    busy = true;
    const active = handle;
    handle = undefined;
    stopTicker();
    setState("transcribing", ctx);

    try {
      const audioPath = await active.stop();
      // A streaming model already decoded the audio while it was being
      // recorded: finishing is instant and needs no second pass.
      const outcome = live
        ? { text: live.finish() }
        : await transcribeFile({ config, audioPath, language: languageOf(config) });

      const text = applyReplacements(outcome.text, config.output.replacements).trim();

      if (!text) {
        abandonDraft(ctx);
        notify(ctx, strings.toast.noSpeech, "warning");
        return;
      }

      if (mode === "test") {
        notify(ctx, strings.command.testResult(text));
        return;
      }

      const formatted = formatTranscript(text, config.output);
      if (draft) {
        paintDraft(ctx, formatted);
        draft = undefined;
      } else {
        insertIntoPrompt(ctx, formatted);
      }
      if (mode === "send") {
        await submitPrompt(ctx);
        notify(ctx, strings.toast.sent(text.length));
      } else {
        notify(ctx, strings.toast.inserted(text.length));
      }
      if (options.timedOut) notify(ctx, strings.toast.timedOut(config.capture.maxSeconds), "warning");
    } catch (error) {
      lastError = errorText(error);
      notify(ctx, lastError, "error");
      abandonDraft(ctx);
    } finally {
      live?.free();
      live = undefined;
      draft = undefined;
      await active.dispose().catch(() => {});
      setState("idle", ctx);
      busy = false;
    }
  };

  const cancelRecording = async (ctx: ExtensionContext): Promise<void> => {
    if (state !== "recording" || !handle) {
      notify(ctx, strings.error.notRecording, "warning");
      return;
    }
    const active = handle;
    handle = undefined;
    stopTicker();
    setState("idle", ctx);
    live?.free();
    live = undefined;
    draft = undefined;
    await active.cancel().catch(() => {});
    notify(ctx, strings.toast.cancelled);
  };

  /** Stop hint for the status label / level meter: depends on the key mode. */
  const stopHint = (): string =>
    config.keybindMode === "hold" ? strings.indicator.holdHint : strings.indicator.recordingHint;

  /** A key press (or auto-repeat, which is filtered out before this point). */
  const toggle = async (ctx: ExtensionContext): Promise<void> => {
    const now = Date.now();
    if (now - lastToggle < TOGGLE_DEBOUNCE_MS) return;
    lastToggle = now;
    if (state === "idle") {
      await startRecording(ctx);
      return;
    }
    if (state !== "recording") return;

    // In hold mode an extra press (the release event went missing) also stops.
    await finishRecording(ctx, config.output.submitOnStop ? "send" : "insert");
  };

  /** Key released: hold-to-talk stops here. Ignored in toggle mode. */
  const release = async (ctx: ExtensionContext): Promise<void> => {
    if (config.keybindMode !== "hold" || state !== "recording") return;
    lastToggle = 0;
    await finishRecording(ctx, config.output.submitOnStop ? "send" : "insert");
  };

  const clearGapTimer = (): void => {
    if (gapTimer) clearTimeout(gapTimer);
    gapTimer = undefined;
  };

  /**
   * "No press for `ms`" means "the key came up". This is what makes hold-to-talk
   * work on terminals that send presses and repeats but never a release; on
   * kitty terminals the real release event arrives first and cancels the timer.
   */
  const armGapTimer = (ctx: ExtensionContext, ms: number): void => {
    clearGapTimer();
    gapTimer = setTimeout(() => {
      gapTimer = undefined;
      if (!keyDown) return;
      keyDown = false;
      // Toggle mode only reacts to presses; holding is not a stop there.
      if (config.keybindMode === "hold") void release(ctx);
    }, ms);
    gapTimer.unref?.();
  };

  const abortHandle = async (): Promise<void> => {
    const active = handle;
    handle = undefined;
    await active?.dispose().catch(() => {});
  };

  const insertIntoPrompt = (ctx: ExtensionContext, text: string): void => {
    if (!text) return;
    const buffer = bufferOf();
    // With the caret inside existing text, add a space where the transcript
    // would otherwise glue onto an ASCII word; at the end of the prompt the
    // configured trailing space already does that job.
    const insert = buffer ? padAtCaret(buffer, text) : text;
    const cursorInsert = editor?.insertTextAtCursor?.bind(editor);
    if (cursorInsert) cursorInsert(insert);
    else ctx.ui.setEditorText(`${ctx.ui.getEditorText()}${insert}`);
  };

  const submitPrompt = async (ctx: ExtensionContext): Promise<void> => {
    const prompt = ctx.ui.getEditorText().trimEnd();
    if (!prompt) {
      notify(ctx, strings.toast.noSpeech, "warning");
      return;
    }
    ctx.ui.setEditorText("");
    if (ctx.isIdle()) pi.sendUserMessage(prompt);
    else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  };

  // ── Editor integration ────────────────────────────────────────────────
  const installEditor = (ctx: ExtensionContext): void => {
    const helpers = editorHelpers;
    if (!helpers) return;
    const ui = ctx.ui as unknown as Record<string, unknown>;
    if (typeof ui.setEditorComponent !== "function" || typeof ui.getEditorComponent !== "function") return;

    const previous = (ui.getEditorComponent as () => BaseEditorFactory | undefined)();
    const factory: BaseEditorFactory = (editorTui, theme, keybindings) => {
      tui = editorTui;
      return createDictationEditorFactory(previous, {
        keybind: config.keybind,
        helpers,
        getState: () => state,
        getTheme: () => ctx.ui.theme,
        getContext: () => sessionCtx ?? ctx,
        onToggle: (activeCtx) => void toggle(activeCtx),
        onCancel: (activeCtx) => void cancelRecording(activeCtx),
        onSend: (activeCtx) => void finishRecording(activeCtx, "send"),
        renderLabel: (theme) =>
          renderIndicator({
            theme,
            state,
            strings,
            keybind: config.keybind,
            stopHint: stopHint(),
            levels: currentLevels(),
            elapsedMs: handle?.elapsedMs() ?? 0,
          }),
        onEditorReady: (component) => {
          editor = component;
        },
      })(editorTui, theme, keybindings);
    };
    (ui.setEditorComponent as (factory: BaseEditorFactory) => void)(factory);
  };

  // ── Registration ──────────────────────────────────────────────────────
  // No `pi.registerShortcut(keybind)`: ctrl+r is also pi's `app.session.rename`,
  // and registering it makes pi print an "Extension shortcut conflict" note on
  // every start. The key is consumed earlier instead, in `onTerminalInput`
  // (see session_start), which also wins over the built-in binding.

  const ACTIONS = ["start", "stop", "send", "cancel", "status", "provider", "model", "mode", "test", "mic", "doctor", "config"];
  const MODEL_ACTIONS = ["use", "download", "delete", "path"];

  /**
   * Argument completion for `/dictation ...`. pi hands over everything typed
   * after the command name and replaces that whole text with the chosen value,
   * so each item's value is the full argument (`model use <id>`), not just the
   * last word. The finished words decide what the next one can be.
   */
  const argumentCompletions = (prefix: string): AutocompleteItem[] | null => {
    const words = prefix.trim() ? prefix.trim().split(/\s+/) : [];
    const done = prefix.endsWith(" ") ? words : words.slice(0, -1);
    const current = (prefix.endsWith(" ") ? "" : words.at(-1) ?? "").toLowerCase();
    const pick = (options: readonly string[], describe?: (value: string) => string | undefined): AutocompleteItem[] | null => {
      const items = options
        .filter((option) => option.toLowerCase().startsWith(current))
        .map((option) => {
          const description = describe?.(option);
          return { value: [...done, option].join(" "), label: option, ...(description ? { description } : {}) };
        });
      return items.length > 0 ? items : null;
    };

    if (done.length === 0) return pick(ACTIONS);
    if (done.length === 1) {
      if (done[0] === "model") return pick(MODEL_ACTIONS);
      if (done[0] === "provider") return pick(["auto", ...Object.keys(config.providers)]);
      if (done[0] === "mode") return pick(KEYBIND_MODES);
      return null;
    }
    if (done.length === 2 && done[0] === "model" && MODEL_ACTIONS.includes(done[1] ?? "")) {
      // Say what each model is, so the picker does not need the list above it.
      const rows = new Map(localModelRows(config).map((row) => [row.id, row]));
      return pick(knownModelIds(), (id) => {
        const row = rows.get(id);
        return row ? `${row.languages} · ${strings.model.kind[row.kind]}${row.active ? ` ${strings.model.active}` : ""}` : undefined;
      });
    }
    return null;
  };

  pi.registerCommand("dictation", {
    description: `${strings.product} — ${strings.command.description}`,
    getArgumentCompletions: argumentCompletions,
    handler: async (args, ctx) => {
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const param = rest.join(" ").trim();
      strings = resolveStrings(config.locale);

      switch (action.toLowerCase()) {
        case "start":
          await startRecording(ctx);
          return;
        case "stop":
          await finishRecording(ctx, "insert");
          return;
        case "send":
          await finishRecording(ctx, "send");
          return;
        case "cancel":
          await cancelRecording(ctx);
          return;
        case "status":
          showStatus(ctx);
          return;
        case "config":
          showConfig(ctx);
          return;
        case "provider":
          await handleProvider(param, ctx);
          return;
        case "model":
          await handleModel(param, ctx);
          return;
        case "mode":
          handleMode(param, ctx);
          return;
        case "test":
          await startRecording(ctx, clampSeconds(param));
          return;
        case "doctor":
          await showDoctor(ctx);
          return;
        case "mic":
          await showMic(ctx);
          return;
        default:
          notify(ctx, strings.command.usage, "error");
      }
    },
  });

  pi.registerTool({
    name: "transcribe_audio",
    label: "Voice Transcribe",
    description:
      "Transcribe an audio file to text with the local speech model or a configured cloud speech service. " +
      "Use for voice notes, meeting recordings, or a WAV produced by the user. The local model reads WAV (any sample rate).",
    promptSnippet: "Transcribe an audio file to text",
    promptGuidelines: [
      "Use transcribe_audio for audio files. The local model reads WAV only — convert other formats first: ffmpeg -i in.mp3 -ar 16000 -ac 1 out.wav",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path to the audio file" }),
      language: Type.Optional(Type.String({ description: "Language hint (e.g. zh, en). Default: auto-detect" })),
      provider: Type.Optional(Type.String({ description: "Provider id override; run /dictation provider to list them" })),
    }),
    async execute(_toolCallId, params, signal) {
      const fresh = loadConfig();
      const outcome = await transcribeFile({
        config: fresh,
        audioPath: params.path,
        language: params.language,
        providerId: params.provider,
        signal,
      });
      const text = outcome.text || "(empty transcript)";
      return {
        content: [{ type: "text" as const, text }],
        details: { provider: outcome.providerId, providerLabel: outcome.providerLabel, characters: outcome.text.length },
      };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
    config = loadConfig();
    strings = resolveStrings(config.locale);
    if (ensureConfigFile(defaultConfigPath())) {
      // First run: the file is now discoverable and editable.
    }

    if (!ctx.hasUI) return;
    try {
      installEditor(ctx);
    } catch (error) {
      lastError = errorText(error);
    }

    // Intercept the hotkey before anything else can claim it. pi's own
    // "rename session" action is also bound to ctrl+r, and a custom editor only
    // receives keys while it has focus, so consuming the raw key here makes the
    // hotkey work in both cases. Repeat events (key held down) are swallowed so
    // holding the key cannot stop the recording, and release events drive
    // hold-to-talk.
    rawInputCleanup?.();
    if (editorHelpers && typeof ctx.ui.onTerminalInput === "function") {
      rawInputCleanup = ctx.ui.onTerminalInput((data) => {
        const helpers = editorHelpers;
        if (!helpers?.matchesKey(data, config.keybind)) return undefined;
        const active = sessionCtx ?? ctx;

        if (helpers.isKeyRelease(data)) {
          const wasDown = keyDown;
          keyDown = false;
          clearGapTimer();
          if (wasDown) void release(active);
          return { consume: true };
        }

        // A press, or an auto-repeat that only the kitty protocol can label as
        // one. Until the gap timer fires, both mean "still held": acting on a
        // repeat would turn one held key into a stream of starts and stops.
        const repeated = keyDown || helpers.isKeyRepeat(data);
        keyDown = true;
        armGapTimer(active, repeated ? GAP_REPEAT_MS : GAP_FIRST_MS);
        if (!repeated) void toggle(active);
        return { consume: true };
      });
    }

    if (!resolveProvider(config)) {
      notify(ctx, noProviderMessage(), "warning");
    }

    // Load a streaming model in the background: it takes about a second, and
    // paying it here keeps the first ctrl+r instant.
    const warmId = streamingModelId();
    if (warmId && modelState(warmId).ready) {
      void loadStreamingRecognizer(warmId).catch((error) => {
        lastError = errorText(error);
      });
    }
    refresh(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopTicker();
    rawInputCleanup?.();
    rawInputCleanup = undefined;
    live?.free();
    live = undefined;
    if (draft && sessionCtx?.hasUI) abandonDraft(sessionCtx);
    draft = undefined;
    await abortHandle();
    editor = undefined;
    tui = undefined;
    state = "idle";
  });

  // ── Command handlers ──────────────────────────────────────────────────
  const showStatus = (ctx: ExtensionContext): void => {
    const resolved = resolveProvider(config);
    const configured = config.provider === "auto" ? "auto" : config.provider;
    const recorder = detectRecorderTool(config.capture);
    const lines = [
      strings.command.status(state, `${resolved ? resolved.id : "none"} (${configured})`, config.keybind, config.keybindMode, ctx.hasUI ? defaultConfigPath() : "-"),
      `recorder: ${recorder.tool ?? "none"} (${recorder.detail})`,
      ...(resolved ? [resolved.status.detail] : []),
      ...providerStatuses(config)
        .filter((status) => !status.ready)
        .map((status) => `· ${status.id}: ${status.detail}`),
      ...(lastError ? [`last error: ${lastError}`] : []),
    ];
    notify(ctx, lines.join("\n"));
  };

  const showConfig = (ctx: ExtensionContext): void => {
    notify(ctx, `config ${defaultConfigPath()}\n${JSON.stringify(redactConfig(config), null, 2)}`);
  };

  const showDoctor = async (ctx: ExtensionContext): Promise<void> => {
    const report = doctorReport(config);
    const mic = await micDiagnostics(config);
    const icon: Record<string, string> = { ok: "✓", warn: "!", fail: "✗" };
    const lines = [
      `${strings.doctor.title}:`,
      ...[...report.lines, ...mic].map((line) => `${icon[line.level]} ${line.text}`),
      strings.doctor.summary(report.ok && mic.every((line) => line.level !== "fail")),
    ];
    notify(ctx, lines.join("\n"), lines.some((line) => line.startsWith("✗")) ? "warning" : "info");
  };

  const showMic = async (ctx: ExtensionContext): Promise<void> => {
    const lines = await micDiagnostics(config);
    const icon: Record<string, string> = { ok: "✓", warn: "!", fail: "✗" };
    notify(ctx, lines.map((line) => `${icon[line.level]} ${line.text}`).join("\n"), lines.some((line) => line.level === "warn") ? "warning" : "info");
  };

  const handleProvider = async (param: string, ctx: ExtensionContext): Promise<void> => {
    const statuses = providerStatuses(config);
    if (!param) {
      const lines = statuses.map((status) => `${status.ready ? "✓" : "✗"} ${status.id} [${status.kind}] — ${status.detail}`);
      notify(ctx, strings.command.providerList(lines.join("\n")));
      return;
    }
    const id = param.trim();
    if (id !== "auto" && !config.providers[id]) {
      notify(ctx, strings.error.unknownProvider(id, `auto, ${Object.keys(config.providers).join(", ")}`), "error");
      return;
    }
    config = { ...config, provider: id };
    saveConfig(config);
    notify(ctx, strings.command.providerSet(id));
    showStatus(ctx);
  };

  /** `/dictation mode hold|toggle` — hold is record-while-held, toggle is press-to-stop. */
  const handleMode = (param: string, ctx: ExtensionContext): void => {
    const wanted = param.trim().toLowerCase();
    if (!isKeybindMode(wanted)) {
      notify(ctx, strings.command.usage, "error");
      return;
    }
    // No restart needed: every recording reloads the config.
    config = { ...config, keybindMode: wanted };
    saveConfig(config);
    notify(ctx, strings.command.modeSet(wanted));
    showStatus(ctx);
  };

  const handleModel = async (param: string, ctx: ExtensionContext): Promise<void> => {
    const [sub = "status", id = DEFAULT_LOCAL_MODEL] = param.split(/\s+/).filter(Boolean);

    if (sub === "download") {
      if (!localModelSpec(id)) {
        notify(ctx, `unknown local model "${id}" (known: ${knownModelIds().join(", ")})`, "error");
        return;
      }
      const spec = localModelSpec(id)!;
      notify(ctx, strings.model.downloading(id, spec.sizeMb));
      let lastPercent = -10;
      try {
        await downloadModel(id, (_message, percent) => {
          if (percent - lastPercent < 10) return;
          lastPercent = percent;
          if (ctx.hasUI) ctx.ui.setStatus("dictation-model", strings.model.progress(percent, 0, spec.sizeMb));
        });
        if (ctx.hasUI) ctx.ui.setStatus("dictation-model", undefined);
        notify(ctx, strings.model.ready(id));
      } catch (error) {
        if (ctx.hasUI) ctx.ui.setStatus("dictation-model", undefined);
        notify(ctx, strings.model.failed(errorText(error)), "error");
      }
      return;
    }

    if (sub === "use") {
      const result = setLocalModel(config, id);
      if (!result.ok) {
        if (result.reason === "unknown") {
          notify(ctx, `unknown local model "${id}" (known: ${knownModelIds().join(", ")})`, "error");
          return;
        }
        notify(ctx, strings.model.missing(id, result.sizeMb), "warning");
        return;
      }
      config = result.config;
      saveConfig(config);
      notify(ctx, describeModelSwitch(id, defaultConfigPath(), strings.model));
      return;
    }

    if (sub === "delete") {
      try {
        const { removed } = await deleteModel(id);
        notify(ctx, removed.length ? strings.model.deleted(id) : `${id} is not downloaded`);
      } catch (error) {
        notify(ctx, strings.model.failed(errorText(error)), "error");
      }
      return;
    }

    if (sub === "path") {
      notify(ctx, `${id}: ${modelState(id).dir}`);
      return;
    }

    const lines = describeLocalModels(config, "/dictation", strings.model);
    notify(ctx, lines.join("\n"));
  };
}

const languageOf = (config: DictationConfig): string | undefined => {
  const resolved = resolveProvider(config);
  const provider = resolved?.config;
  if (provider && "language" in provider) return provider.language;
  return undefined;
};

const errorText = (error: unknown): string => {
  const detail = error instanceof Error ? error.message : String(error);
  return detail;
};

const clampSeconds = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(60, Math.max(1, parsed));
};
