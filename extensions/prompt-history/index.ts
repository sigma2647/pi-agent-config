/**
 * Ctrl+R reverse search over prompt history, as a floating panel.
 *
 * The panel is a real overlay (`ctx.ui.custom(..., { overlay: true })`), so it
 * floats over pi's content instead of pushing anything around — the editor keeps
 * its text and its height, and the overlay can be bigger than the prompt box
 * when there is more to show.
 *
 * History comes from session files pi already writes (see history.ts), so this
 * extension stores no second copy of your prompts.
 *
 * The hotkey is ctrl+r by default; `~/.pi/agent/prompt-history.json` moves it.
 * Extension raw input runs before the focused editor does, and dictation claims
 * ctrl+r by default, so on a default setup the panel would never open.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CustomEditor,
  type EditorFactory,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorComponent,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { branchPrompts, loadRecentPrompts } from "./history.ts";
import { mergeNewestFirst } from "./prompts.ts";
import {
  filterMatches,
  FIXED_ROWS,
  MAX_LIST_LINES,
  renderOverlay,
  type SearchPaint,
} from "./search.ts";

/** The hotkey when nothing else is configured. */
const DEFAULT_KEYBIND = "ctrl+r";
/** The panel's own "next match" key: fixed, it is what the panel is modelled on. */
const SEARCH_KEY = "ctrl+r";

/** `~/.pi/agent/prompt-history.json`: `{"keybind": "f8"}`. */
function loadKeybind(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, "prompt-history.json"), "utf8")) as { keybind?: unknown };
    return typeof raw.keybind === "string" && raw.keybind.trim() ? raw.keybind.trim() : DEFAULT_KEYBIND;
  } catch {
    return DEFAULT_KEYBIND;
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A notification is the only channel a background failure has. */
const warn = (ctx: ExtensionContext, message: string): void => {
  try {
    ctx.ui.notify(message, "warning");
  } catch {
    // A context that died during shutdown must not turn into a crash.
  }
};
/** Overlay placement: full width, floating above the prompt box. */
const OVERLAY = { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "80%" } } as const;

type SearchRequest = {
  tui: TUI;
  theme: Theme;
  /** Search pool, newest first. */
  history(): string[];
  /** Editor text when the search opened; the query starts from it. */
  draft: string;
  done(match: string | null): void;
};

/** The floating panel: owns the query, the cursor and the selection. */
export class SearchOverlay implements Component {
  private query: string;
  /** Cursor inside `query`: emacs C-a/C-e, home/end and the arrows move it. */
  private cursor: number;
  private pointer = 0;
  private matches: string[];

  constructor(private readonly options: SearchRequest) {
    // One line only: a multi-line draft would put newlines inside the query row.
    this.query = options.draft.replace(/\s+/g, " ").trim();
    this.cursor = this.query.length;
    this.matches = filterMatches(options.history(), this.query);
  }

  render(width: number): string[] {
    return renderOverlay({
      query: this.query,
      cursor: this.cursor,
      matches: this.matches,
      pointer: this.pointer,
      // Hug the results: the panel is floating, so it can be exactly as tall as it
      // needs to be, inside the terminal.
      listLines: Math.max(
        1,
        Math.min(
          MAX_LIST_LINES,
          Math.max(1, (this.options.tui.terminal?.rows ?? 24) - FIXED_ROWS),
          Math.max(1, this.matches.length),
        ),
      ),
      width,
      widthOf: visibleWidth,
      fit: (text, budget) => truncateToWidth(text.replace(/[\r\n]+/g, " "), budget, "…"),
      paint: paintFrom(this.options.theme),
    });
  }

  handleInput(data: string): void {
    // Emacs/readline keys first: they are what this panel is modelled on.
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+g") || matchesKey(data, "ctrl+c")) {
      this.options.done(null);
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "ctrl+j")) {
      const match = this.matches[this.pointer];
      if (match !== undefined) this.options.done(match);
      return;
    }
    if (matchesKey(data, "ctrl+k")) {
      this.edit(this.query.slice(0, this.cursor));
      return;
    }
    if (matchesKey(data, "ctrl+a") || matchesKey(data, "home")) {
      this.moveCursor(0);
      return;
    }
    if (matchesKey(data, "ctrl+e") || matchesKey(data, "end")) {
      this.moveCursor(this.query.length);
      return;
    }
    if (matchesKey(data, "left")) {
      this.moveCursor(this.cursor - 1);
      return;
    }
    if (matchesKey(data, "right")) {
      this.moveCursor(this.cursor + 1);
      return;
    }
    // Older is `down` in the list on screen, and C-r repeats zsh's direction;
    // C-n/C-p are emacs next-line/previous-line.
    if (matchesKey(data, "ctrl+n") || matchesKey(data, "down") || matchesKey(data, SEARCH_KEY)) {
      this.cycle(1);
      return;
    }
    if (matchesKey(data, "ctrl+p") || matchesKey(data, "up")) {
      this.cycle(-1);
      return;
    }
    if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
      if (this.cursor === 0) return;
      this.edit(this.query.slice(0, this.cursor - 1) + this.query.slice(this.cursor), this.cursor - 1);
      return;
    }
    if (data.length === 1 && (data.codePointAt(0) ?? 0) >= 32) this.insert(data);
    // Anything else is not ours.
  }

  invalidate(): void {
    // Nothing cached: every render reads the live query and matches.
  }

  private insert(text: string): void {
    this.edit(this.query.slice(0, this.cursor) + text + this.query.slice(this.cursor), this.cursor + text.length);
  }

  private edit(query: string, cursor = query.length): void {
    this.query = query;
    this.cursor = Math.max(0, Math.min(cursor, query.length));
    this.matches = filterMatches(this.options.history(), query);
    this.pointer = 0;
    this.options.tui.requestRender();
  }

  private moveCursor(at: number): void {
    this.cursor = Math.max(0, Math.min(at, this.query.length));
    this.options.tui.requestRender();
  }

  private cycle(step: number): void {
    const total = this.matches.length;
    if (total === 0) return;
    this.pointer = (this.pointer + step + total) % total;
    this.options.tui.requestRender();
  }
}

/** Wrap whatever editor pi installed so Ctrl+R can open the panel. */
export class PromptHistoryEditor implements EditorComponent {
  constructor(
    private readonly base: EditorComponent,
    private readonly options: { keybind: string; onSearch(): void },
  ) {}

  getText(): string {
    return this.base.getText();
  }

  setText(text: string): void {
    this.base.setText(text);
  }

  addToHistory(text: string): void {
    this.base.addToHistory?.(text);
  }

  invalidate(): void {
    this.base.invalidate();
  }

  render(width: number): string[] {
    return this.base.render(width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, this.options.keybind)) {
      this.options.onSearch();
      return;
    }
    this.base.handleInput(data);
  }
}

const paintFrom = (theme: Theme): SearchPaint => {
  const fg = (color: Parameters<Theme["fg"]>[0], text: string): string =>
    typeof theme?.fg === "function" ? theme.fg(color, text) : text;
  const bg = (color: Parameters<Theme["bg"]>[0], text: string): string =>
    typeof theme?.bg === "function" ? theme.bg(color, text) : text;
  return {
    accent: (text) => fg("accent", text),
    border: (text) => fg("border", text),
    dim: (text) => fg("dim", text),
    text: (text) => fg("text", text),
    selected: (text) => bg("selectedBg", text),
  };
};

/** Forward members this wrapper does not implement to the editor underneath. */
const forwardUnknown = (wrapper: PromptHistoryEditor, base: EditorComponent): EditorComponent =>
  new Proxy(wrapper, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      const value = Reflect.get(base, prop) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(base) : value;
    },
    set(target, prop, value, receiver) {
      return Reflect.has(target, prop) ? Reflect.set(target, prop, value, receiver) : Reflect.set(base, prop, value);
    },
    has(target, prop) {
      return Reflect.has(target, prop) || Reflect.has(base, prop);
    },
  }) as EditorComponent;

export default function promptHistory(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const keybind = loadKeybind();
    const previous: EditorFactory | undefined = ctx.ui.getEditorComponent();

    // Reading every session file in this directory costs a few hundred ms on a
    // large history, and the editor is not even wrapped until this handler
    // returns, so this must not be awaited here. history() picks the result up
    // per keystroke, so the entries appear as soon as the load lands. The
    // rejection is caught on purpose: pi has no unhandledRejection handler, and
    // an escaped one would take the process down.
    let fromDisk: string[] | undefined;
    void loadRecentPrompts(ctx.cwd)
      .then((loaded) => {
        fromDisk = loaded.prompts;
        if (loaded.error) warn(ctx, `历史读取失败：${loaded.error}（本次只搜当前会话）`);
      })
      .catch((error: unknown) => warn(ctx, `历史读取失败：${errorText(error)}（本次只搜当前会话）`));

    const openSearch = async (draft: string): Promise<void> => {
      // Deliberately no await before custom(): pi expects the overlay to be
      // opened from the key handler that is running here. The disk history may
      // still be loading; history() re-reads it on every keystroke, so it
      // appears as soon as the background load lands.
      const history = (): string[] => mergeNewestFirst(branchPrompts(ctx.sessionManager), fromDisk ?? []);

      let live: TUI | undefined;
      const match = await ctx.ui.custom<string | null>(
        (tui, theme, _keybindings, done) => {
          live = tui;
          return new SearchOverlay({ tui, theme, history, draft, done });
        },
        OVERLAY,
      );

      // null: cancelled. undefined: the overlay went away with no result (a
      // session switch). Either way the draft stays untouched.
      if (match == null) return;
      ctx.ui.setEditorText(match);
      // setEditorText does not repaint on its own, and the repaint triggered by
      // hiding the overlay runs before this continuation.
      live?.requestRender();
    };

    ctx.ui.setEditorComponent((tui, theme: EditorTheme, keybindings: KeybindingsManager) => {
      const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      const wrapper = new PromptHistoryEditor(base, {
        keybind,
        // Opening the panel is fire-and-forget from the editor's point of view,
        // so its failure has to be handled here.
        onSearch: () => {
          openSearch(base.getText()).catch((error: unknown) => warn(ctx, `搜索面板打不开：${errorText(error)}`));
        },
      });
      return forwardUnknown(wrapper, base);
    });
  });
}
