/**
 * Editor-integrated indicator.
 *
 * Two visible surfaces, both driven by the same state:
 *   1. a right-aligned label inside the prompt border (always visible),
 *   2. a one-line level meter above the editor while recording.
 *
 * This module deliberately has no runtime dependency on pi packages: the host
 * injects `EditorHelpers` (pi-tui width/key helpers plus a base-editor
 * factory). That keeps the render helpers unit-testable with plain Node and
 * keeps the CLI free of TUI imports.
 */

import type { EditorComponent, EditorTheme, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { normalizeLevel } from "./wav.ts";
import type { Strings } from "./strings.ts";

export type { EditorComponent } from "@earendil-works/pi-tui";
export type { Theme } from "@earendil-works/pi-coding-agent";

export type DictationState = "idle" | "recording" | "transcribing";

export type EditorHelpers = {
  matchesKey(data: string, key: string): boolean;
  /** True for kitty-protocol key-repeat events (auto-repeat while held). */
  isKeyRepeat(data: string): boolean;
  /** True for kitty-protocol key-release events (needed for hold-to-talk). */
  isKeyRelease(data: string): boolean;
  truncateToWidth(text: string, width: number, ellipsis?: string): string;
  visibleWidth(text: string): number;
  createBase(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): EditorComponent;
};

/** The slice of pi's editor factory this module needs. */
export type BaseEditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export const formatClock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

/** Map raw RMS levels to bar characters. Silence renders as thin bars, not blanks. */
export const renderBars = (levels: number[], width = 12): string => {
  const padded = levels.slice(-width);
  while (padded.length < width) padded.unshift(0);
  return padded
    .map((level) => BARS[Math.min(BARS.length - 1, Math.max(0, Math.round(normalizeLevel(level) * (BARS.length - 1))))] ?? "▁")
    .join("");
};

export const renderIndicator = (options: {
  theme: Theme;
  state: DictationState;
  strings: Strings;
  keybind: string;
  /** Mode-dependent stop hint, e.g. "松开结束". */
  stopHint: string;
  levels?: number[];
  elapsedMs?: number;
}): string => {
  const { theme, state, strings, keybind } = options;

  if (state === "recording") {
    return [
      theme.fg("error", "●"),
      theme.fg("error", strings.indicator.recording),
      theme.fg("accent", renderBars(options.levels ?? [], 10)),
      theme.fg("dim", formatClock(options.elapsedMs ?? 0)),
    ].join(" ");
  }

  if (state === "transcribing") {
    return `${theme.fg("warning", "◌")} ${theme.fg("warning", strings.indicator.transcribing)}`;
  }

  return `${theme.fg("dim", strings.indicator.idle)} ${theme.fg("accent", keybind)}`;
};

/** Level meter line shown above the editor while recording. */
export const renderWidget = (options: {
  theme: Theme;
  levels: number[];
  elapsedMs: number;
  maxMs: number;
  keybind: string;
  stopHint: string;
  strings: Strings;
}): string => {
  const { theme, strings, keybind } = options;
  return [
    theme.fg("error", "🎙"),
    theme.fg("accent", renderBars(options.levels, 24)),
    theme.fg("dim", `${formatClock(options.elapsedMs)} / ${formatClock(options.maxMs)}`),
    theme.fg("dim", `${keybind} ${options.stopHint} · ⏎ ${strings.indicator.sendHint} · ⎋ ${strings.indicator.cancelHint}`),
  ].join("  ");
};

/** One line of live (streaming) transcript: the newest words stay visible. */
export const renderLiveText = (options: {
  theme: Theme;
  text: string;
  strings: Strings;
  width?: number;
  measure?: (text: string) => number;
}): string => {
  const { theme, strings } = options;
  const label = `${strings.indicator.live} `;
  const room = Math.max(12, (options.width ?? 80) - label.length - 1);
  return `${theme.fg("dim", label)}${theme.fg("accent", keepTail(options.text, room, options.measure))}`;
};

/** Keep the last `width` columns of `text`, measuring with real terminal width. */
export const keepTail = (text: string, width: number, measure?: (value: string) => number): string => {
  const characters = [...text];
  let visible = text;
  // Start from a bounded tail: measuring the whole string on every render tick
  // is wasted work once the transcript is longer than the line.
  if (characters.length > 400) visible = characters.slice(-400).join("");
  if (!measure) return visible.slice(-width);
  while (visible.length > 0 && measure(visible) > width) visible = visible.slice(1);
  return visible;
};

/** Live insert into the prompt: origin is -1 until the first token, then the caret offset at insert. */
export type LiveDraft = {
  origin: number;
  lastLive: string;
  /** ASR prefix already committed or discarded (Ctrl+U). Never insert this again. */
  ignored: string;
};

export const cursorOffset = (text: string, cursor: { line: number; col: number }): number => {
  const lines = text.split("\n");
  const line = Math.max(0, Math.min(cursor.line, Math.max(0, lines.length - 1)));
  let offset = 0;
  for (let index = 0; index < line; index += 1) offset += (lines[index]?.length ?? 0) + 1;
  return offset + Math.max(0, Math.min(cursor.col, lines[line]?.length ?? 0));
};

export const offsetCursor = (text: string, offset: number): { line: number; col: number } => {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, clamped);
  const lines = before.split("\n");
  return { line: lines.length - 1, col: lines.at(-1)?.length ?? 0 };
};

const bufferText = (editor: EditorBuffer): string => editor.state?.lines.join("\n") ?? editor.getText();

export const liveSpanIntact = (text: string, origin: number, lastLive: string): boolean =>
  origin >= 0 && lastLive.length > 0 && text.slice(origin, origin + lastLive.length) === lastLive;

/** Strip the ASR prefix the user already kept or deleted. */
export const visibleLive = (live: string, ignored: string): string => {
  if (!ignored) return live;
  if (live.startsWith(ignored)) return live.slice(ignored.length);
  return "";
};

const commitLiveSpan = (draft: LiveDraft): void => {
  draft.ignored += draft.lastLive;
  draft.origin = -1;
  draft.lastLive = "";
};

const insertAtCaret = (editor: EditorBuffer, text: string): number => {
  if (typeof editor.insertTextAtCursor === "function") {
    const origin = editorCursorOffset(editor);
    editor.insertTextAtCursor(text);
    return origin;
  }
  return insertAtEditorCursor(editor, text);
};

/**
 * Paint the current hypothesis. In-place only while the caret stays at the
 * end of the live span; a click/arrow into the middle (or Ctrl+U) commits
 * those words and inserts new speech at the caret.
 */
export const applyLiveDraft = (editor: EditorBuffer, draft: LiveDraft, live: string): void => {
  const text = bufferText(editor);
  const caret = editorCursorOffset(editor);
  const intact = liveSpanIntact(text, draft.origin, draft.lastLive);
  const following = intact && caret === draft.origin + draft.lastLive.length;

  if (draft.lastLive && !following) commitLiveSpan(draft);
  if (draft.ignored && !live.startsWith(draft.ignored) && !draft.ignored.startsWith(live)) {
    draft.ignored = live;
  }

  const visible = visibleLive(live, draft.ignored);
  if (visible === draft.lastLive) return;

  if (liveSpanIntact(bufferText(editor), draft.origin, draft.lastLive)) {
    replaceEditorRange(editor, draft.origin, draft.lastLive.length, visible);
    const next = bufferText(editor);
    const pos = offsetCursor(next, draft.origin + visible.length);
    placeEditorCursor(editor, pos.line, pos.col);
    draft.lastLive = visible;
    return;
  }

  if (!visible) return;
  draft.origin = insertAtCaret(editor, visible);
  draft.lastLive = visible;
};

export type EditorBuffer = {
  getText(): string;
  setText(text: string): void;
  insertTextAtCursor?: (text: string) => void;
  getCursor?: () => { line: number; col: number };
  state?: { lines: string[]; cursorLine: number; cursorCol: number };
  setCursorCol?: (col: number) => void;
  onChange?: (text: string) => void;
  invalidate?: () => void;
};

export const editorCursorOffset = (editor: EditorBuffer): number => {
  if (editor.state?.lines) {
    return cursorOffset(editor.state.lines.join("\n"), { line: editor.state.cursorLine, col: editor.state.cursorCol });
  }
  const text = editor.getText();
  const cursor = editor.getCursor?.();
  return cursor ? cursorOffset(text, cursor) : text.length;
};

/** Replace `length` chars at `start`. Avoids setText, which always moves the caret to the end. */
export const replaceEditorRange = (editor: EditorBuffer, start: number, length: number, insert: string): string => {
  const current = editor.state?.lines ? editor.state.lines.join("\n") : editor.getText();
  const from = Math.max(0, Math.min(start, current.length));
  const next = `${current.slice(0, from)}${insert}${current.slice(from + Math.max(0, length))}`;
  if (editor.state) {
    const lines = next.split("\n");
    editor.state.lines = lines.length === 0 ? [""] : lines;
    editor.onChange?.(next);
    editor.invalidate?.();
    return next;
  }
  editor.setText(next);
  return next;
};

/** Walk `.base` to the pi-tui Editor that actually owns `state.lines`. */
export const unwrapEditor = (editor: object): EditorBuffer => {
  let current: object = editor;
  for (let index = 0; index < 8; index += 1) {
    const next = (current as { base?: object }).base;
    if (!next || typeof next !== "object") break;
    current = next;
  }
  return current as EditorBuffer;
};

/** Insert `text` at the real caret (`state.cursorLine/Col`), never by appending getText(). */
export const insertAtEditorCursor = (editor: EditorBuffer, text: string): number => {
  const origin = editorCursorOffset(editor);
  if (!text) return origin;
  const state = editor.state;
  if (state?.lines) {
    const lineIndex = Math.max(0, Math.min(state.cursorLine, Math.max(0, state.lines.length - 1)));
    const line = state.lines[lineIndex] ?? "";
    const col = Math.max(0, Math.min(state.cursorCol, line.length));
    const parts = text.split("\n");
    if (parts.length === 1) {
      state.lines[lineIndex] = `${line.slice(0, col)}${text}${line.slice(col)}`;
      state.cursorLine = lineIndex;
      state.cursorCol = col + text.length;
    } else {
      const last = parts.at(-1) ?? "";
      state.lines.splice(
        lineIndex,
        1,
        `${line.slice(0, col)}${parts[0]}`,
        ...parts.slice(1, -1),
        `${last}${line.slice(col)}`,
      );
      state.cursorLine = lineIndex + parts.length - 1;
      state.cursorCol = last.length;
    }
    editor.onChange?.(state.lines.join("\n"));
    editor.invalidate?.();
    editor.setCursorCol?.(state.cursorCol);
    return origin;
  }
  if (typeof editor.insertTextAtCursor === "function") {
    editor.insertTextAtCursor(text);
    return origin;
  }
  const current = editor.getText();
  const next = `${current.slice(0, origin)}${text}${current.slice(origin)}`;
  editor.setText(next);
  const pos = offsetCursor(next, origin + text.length);
  placeEditorCursor(editor, pos.line, pos.col);
  return origin;
};

/** pi-tui Editor has getCursor but no public setCursor; the instance still has setCursorCol + state. */
export const placeEditorCursor = (editor: object, line: number, col: number): void => {
  const host = editor as { state?: { cursorLine: number; cursorCol: number }; setCursorCol?: (col: number) => void };
  if (host.state) {
    host.state.cursorLine = line;
    host.state.cursorCol = col;
  }
  host.setCursorCol?.(col);
};

export type DictationEditorOptions = {
  keybind: string;
  helpers: EditorHelpers;
  getState(): DictationState;
  getTheme(): Theme;
  getContext(): ExtensionContext;
  onToggle(ctx: ExtensionContext): void;
  onCancel(ctx: ExtensionContext): void;
  onSend(ctx: ExtensionContext): void;
  renderLabel(theme: Theme): string;
  onEditorReady(editor: EditorComponent | undefined): void;
};

/** Right-align `label` inside a rendered line of `width` columns. */
export const injectRightLabel = (line: string, width: number, label: string, helpers: EditorHelpers): string => {
  const labelWidth = helpers.visibleWidth(label);
  if (width <= 0) return "";
  if (labelWidth <= 0) return helpers.truncateToWidth(line, width, "");
  if (labelWidth >= width) return helpers.truncateToWidth(label, width, "");

  const gap = " ";
  const leftWidth = Math.max(0, width - labelWidth - helpers.visibleWidth(gap));
  const left = helpers.truncateToWidth(line, leftWidth, "");
  return helpers.truncateToWidth(`${left}${gap}${label}`, width, "");
};

class DictationEditor implements EditorComponent {
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  borderColor?: (str: string) => string;

  // Note: no TypeScript parameter properties — the CLI and tests run these
  // files under Node's strip-only type stripping, which rejects them.
  private readonly base: EditorComponent;
  private readonly options: DictationEditorOptions;
  private readonly defaultBorderColor: (str: string) => string;

  constructor(base: EditorComponent, options: DictationEditorOptions, defaultBorderColor: (str: string) => string) {
    this.base = base;
    this.options = options;
    this.defaultBorderColor = defaultBorderColor;
  }

  // pi's interactive mode duck-types these members on the editor component.
  // Without forwarding them, Ctrl+D (exit), Escape, image paste and extension
  // shortcuts are silently swallowed.
  private get ref(): Record<string, unknown> {
    return this.base as unknown as Record<string, unknown>;
  }

  get actionHandlers(): unknown {
    return this.ref.actionHandlers;
  }

  get onCtrlD(): unknown {
    return this.ref.onCtrlD;
  }
  set onCtrlD(value: unknown) {
    this.ref.onCtrlD = value;
  }

  get onEscape(): unknown {
    return this.ref.onEscape;
  }
  set onEscape(value: unknown) {
    this.ref.onEscape = value;
  }

  get onPasteImage(): unknown {
    return this.ref.onPasteImage;
  }
  set onPasteImage(value: unknown) {
    this.ref.onPasteImage = value;
  }

  get onExtensionShortcut(): unknown {
    return this.ref.onExtensionShortcut;
  }
  set onExtensionShortcut(value: unknown) {
    this.ref.onExtensionShortcut = value;
  }

  get focused(): boolean {
    return Boolean((this.base as EditorComponent & { focused?: boolean }).focused);
  }

  set focused(value: boolean) {
    (this.base as EditorComponent & { focused?: boolean }).focused = value;
  }

  private syncBase(): void {
    if (this.onSubmit) this.base.onSubmit = this.onSubmit;
    else delete this.base.onSubmit;
    if (this.onChange) this.base.onChange = this.onChange;
    else delete this.base.onChange;
  }

  private applyBorder(): void {
    const state = this.options.getState();
    const theme = this.options.getTheme();
    if (state === "recording") this.base.borderColor = (str: string) => theme.fg("error", str);
    else if (state === "transcribing") this.base.borderColor = (str: string) => theme.fg("warning", str);
    else this.base.borderColor = this.borderColor ?? this.defaultBorderColor;
  }

  render(width: number): string[] {
    this.syncBase();
    this.applyBorder();
    const lines = this.base.render(width);
    if (lines.length === 0) return lines;
    lines[0] = injectRightLabel(lines[0] ?? "", width, this.options.renderLabel(this.options.getTheme()), this.options.helpers);
    return lines;
  }

  handleInput(data: string): void {
    this.syncBase();
    const ctx = this.options.getContext();
    const state = this.options.getState();

    if (this.options.helpers.matchesKey(data, this.options.keybind)) {
      this.options.onToggle(ctx);
      return;
    }
    if (state !== "idle" && this.options.helpers.matchesKey(data, "escape")) {
      this.options.onCancel(ctx);
      return;
    }
    if (state === "recording" && this.options.helpers.matchesKey(data, "enter")) {
      this.options.onSend(ctx);
      return;
    }
    this.base.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent) {
    const host = this.base as EditorComponent & { handleMouse?: (mouse: TuiMouseEvent) => ReturnType<NonNullable<EditorComponent["handleMouse"]>> };
    return host.handleMouse?.(event);
  }

  insertTextAtCursor(text: string): void {
    insertAtEditorCursor(unwrapEditor(this.base), text);
  }

  getText(): string {
    return this.base.getText();
  }

  getCursor(): { line: number; col: number } {
    const host = this.base as { getCursor?: () => { line: number; col: number } };
    if (typeof host.getCursor === "function") return host.getCursor();
    const text = this.base.getText();
    return { line: 0, col: text.length };
  }

  setText(text: string): void {
    this.syncBase();
    this.base.setText(text);
  }

  addToHistory(text: string): void {
    this.base.addToHistory?.(text);
  }

  getExpandedText(): string {
    return this.base.getExpandedText?.() ?? this.base.getText();
  }

  setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void {
    this.base.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.base.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.base.setAutocompleteMaxVisible?.(maxVisible);
  }

  invalidate(): void {
    this.base.invalidate?.();
  }

  dispose(): void {
    (this.base as EditorComponent & { dispose?: () => void }).dispose?.();
  }
}

/**
 * Wrap the editor pi would install (or a fresh base editor) so our label,
 * border tint and recording keys layer on top of whatever else is installed.
 */
export const createDictationEditorFactory = (
  previousFactory: BaseEditorFactory | undefined,
  options: DictationEditorOptions,
): BaseEditorFactory => {
  return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): EditorComponent => {
    const base = previousFactory?.(tui, theme, keybindings) ?? options.helpers.createBase(tui, theme, keybindings);
    const wrapper = new DictationEditor(base, options, base.borderColor ?? theme.borderColor);

    // Forward unknown members to the base editor so host duck-typing keeps working.
    const proxied = new Proxy(wrapper, {
      get(target, prop, receiver) {
        if (Reflect.has(target, prop)) {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        const baseValue = Reflect.get(base, prop);
        return typeof baseValue === "function" ? baseValue.bind(base) : baseValue;
      },
      set(target, prop, value, receiver) {
        if (Reflect.has(target, prop)) return Reflect.set(target, prop, value, receiver);
        return Reflect.set(base, prop, value);
      },
      has(target, prop) {
        return Reflect.has(target, prop) || Reflect.has(base, prop);
      },
    }) as EditorComponent;
    // Must be the proxy: the raw wrapper has no getCursor/setCursorCol, so live
    // insert would always capture offset = text.length (the end of the prompt).
    options.onEditorReady(proxied);
    return proxied;
  };
};
