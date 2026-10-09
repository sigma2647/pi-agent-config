/**
 * Inline Slash — use `/template` and `/skill:name` anywhere in a sentence.
 *
 * Pi core handles both only when the whole input starts with `/`:
 * `expandPromptTemplate` and `_expandSkillCommand` each return early unless the
 * text begins with the command, and the completion menu only opens at the start
 * of the first line. This extension closes both gaps:
 *
 * - completion: type `/` plus a letter and a menu pops up — prompt templates and
 *   skills, mid-sentence and on later lines;
 * - prompt templates are substituted in place, where the token stands;
 * - skills are injected the way pi injects them, as a `<skill>` block in front
 *   of the message, and the `/skill:name` token stays in the sentence.
 *
 * Built-in commands (`/model`, `/compact`) and extension commands are not
 * offered: pi dispatches those before this event ever fires, so a token written
 * here would sit in the text and do nothing.
 *
 * Deliberately narrow scope:
 * - fenced code blocks and inline code spans are left untouched;
 * - unknown tokens and path-like strings (`/home/me/file.ts`) are left alone;
 * - input that starts with `/` is passed through, so core keeps handling its
 *   argument parsing exactly as before.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
	EditorComponent,
	EditorTheme,
	KeybindingsManager,
	TUI,
} from "@earendil-works/pi-tui";
import type {
	EditorFactory,
	ExtensionAPI,
	ExtensionContext,
	InputEventResult,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

/** A slash token: `/`, an optional `skill:`, then a name without `/` or `.`. */
const TOKEN = /\/((?:skill:)?[A-Za-z0-9][A-Za-z0-9_-]*)/g;

/** Characters that may sit in front of an inline token. CJK punctuation included. */
const BOUNDARY_CHARS = "\\s，。、；：？！（）「」『』【】《》";
const BOUNDARY_CHAR = new RegExp(`[${BOUNDARY_CHARS}]`, "u");
const BOUNDARY = new RegExp(`(?:^|[${BOUNDARY_CHARS}])\\/((?:skill:)?[A-Za-z0-9][A-Za-z0-9_-]*)?$`);

const SKILL_PREFIX = "skill:";

/** How many candidates the menu shows. */
const MAX_SUGGESTIONS = 20;

/** A command this extension can act on, with its body already read off disk. */
export type InlineCommand = {
	name: string;
	kind: "prompt" | "skill";
	body: string;
	path?: string;
	baseDir?: string;
};

/** Strip a leading `---` frontmatter block, keeping the body. */
export function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) return text;
	const close = text.indexOf("\n---", 3);
	if (close === -1) return text;
	const after = text.indexOf("\n", close + 1);
	return after === -1 ? "" : text.slice(after + 1);
}

/** Resolve the argument placeholders core would fill, with no arguments given. */
export function withoutArgs(body: string): string {
	return body
		.replace(/\$\{[0-9]+:-([^}]*)\}/g, "$1")
		.replace(/\$\{[^}]*\}/g, "")
		.replace(/\$[0-9]+/g, "")
		.replace(/\$@|\$ARGUMENTS/g, "")
		.trim();
}

/** A token found outside code blocks and code spans. */
type Token = { name: string; start: number; end: number };

/** Find every inline token in `text`, skipping fenced blocks, code spans, and paths. */
export function scanTokens(text: string): Token[] {
	const found: Token[] = [];
	const pattern = new RegExp(TOKEN.source, "g");
	let inFence = false;
	let lineStart = 0;

	for (const line of text.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
		} else if (!inFence) {
			// Blank out code spans so a token inside backticks is not seen.
			const masked = line.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
			let match: RegExpExecArray | null;
			while ((match = pattern.exec(masked)) !== null) {
				const start = lineStart + match.index;
				const end = start + match[0].length;
				// A `/` glued to the preceding word is a path, not a token: `/usr/local`
				// must not offer `local` as a name.
				if (start > 0 && !BOUNDARY_CHAR.test(text[start - 1])) continue;
				const next = text[end];
				if (next === "/" || next === ".") continue; // path-like, e.g. /home/me
				found.push({ name: match[1], start, end });
			}
		}
		lineStart += line.length + 1;
	}
	return found;
}

/**
 * Rewrite `text`: prompt templates are replaced where they stand, skills are
 * collected for the caller to inject in front. Returns the new text only when a
 * template was replaced.
 */
export function applyInline(
	text: string,
	registry: Map<string, InlineCommand>,
): { text?: string; skills: InlineCommand[] } {
	const skills: InlineCommand[] = [];
	const seen = new Set<string>();
	let result = "";
	let cursor = 0;
	let changed = false;

	for (const token of scanTokens(text)) {
		const command = registry.get(token.name);
		if (!command) continue;
		if (command.kind === "skill") {
			if (!seen.has(command.name)) {
				seen.add(command.name);
				skills.push(command);
			}
			continue; // the token stays in the sentence
		}
		result += text.slice(cursor, token.start) + command.body;
		cursor = token.end;
		changed = true;
	}

	result += text.slice(cursor);
	return { text: changed ? result : undefined, skills };
}

/** The `<skill>` block pi injects for `/skill:name`; mirrors core's `_expandSkillCommand`. */
export function skillBlock(skill: InlineCommand): string {
	const name = skill.name.startsWith(SKILL_PREFIX) ? skill.name.slice(SKILL_PREFIX.length) : skill.name;
	const location = skill.path ?? "";
	return `<skill name="${name}" location="${location}">\nReferences are relative to ${skill.baseDir ?? dirname(location)}.\n\n${skill.body.trim()}\n</skill>`;
}

/** The `/name` token the cursor sits in, if any. `query` is empty right after the slash. */
export function inlineToken(textBeforeCursor: string): { query: string; start: number } | undefined {
	const match = textBeforeCursor.match(BOUNDARY);
	if (!match) return undefined;
	const query = match[1] ?? "";
	return { query, start: textBeforeCursor.length - query.length - 1 };
}

/** Commands this extension can complete: prompt templates and skills. */
function inlineCommands(pi: ExtensionAPI): SlashCommandInfo[] {
	try {
		return pi.getCommands().filter((command) => command.source === "prompt" || command.source === "skill");
	} catch {
		return [];
	}
}

/** Read the bodies of the commands above. Read fresh so `/reload` takes effect. */
function loadRegistry(pi: ExtensionAPI): Map<string, InlineCommand> {
	const registry = new Map<string, InlineCommand>();
	for (const command of inlineCommands(pi)) {
		const path = command.sourceInfo?.path;
		if (!path) continue;
		try {
			const raw = readFileSync(path, "utf8");
			const kind = command.source === "skill" ? "skill" : "prompt";
			registry.set(command.name, {
				name: command.name,
				kind,
				body: kind === "skill" ? stripFrontmatter(raw).trim() : withoutArgs(stripFrontmatter(raw)),
				path,
				baseDir: command.sourceInfo?.baseDir,
			});
		} catch {
			// Unreadable file: leave its token alone rather than break the send.
		}
	}
	return registry;
}

/**
 * Match a partially typed token against command names: plain case-insensitive
 * substring, exact name first, then leftmost match, then shortest name.
 */
export function matchCommands(commands: SlashCommandInfo[], query: string): SlashCommandInfo[] {
	if (query === "") return commands.slice(0, MAX_SUGGESTIONS);

	const needle = query.toLowerCase();
	return commands
		.flatMap((command) => {
			const at = command.name.toLowerCase().indexOf(needle);
			if (at === -1) return [];
			return [{ command, at, exact: command.name.toLowerCase() === needle }];
		})
		.sort(
			(a, b) =>
				Number(b.exact) - Number(a.exact) || a.at - b.at || a.command.name.length - b.command.name.length,
		)
		.slice(0, MAX_SUGGESTIONS)
		.map((hit) => hit.command);
}

/** Render command names as autocomplete items. */
function toItems(commands: SlashCommandInfo[]): AutocompleteItem[] {
	return commands.map((command) => ({
		value: `/${command.name}`,
		label: `/${command.name}`,
		...(command.description && { description: command.description }),
	}));
}

/** Wrap the built-in provider: inline tokens get our suggestions, everything else is untouched. */
export function createInlineSlashProvider(
	current: AutocompleteProvider,
	pi: ExtensionAPI,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const token = inlineToken(line.slice(0, cursorCol));

			// No inline token, or the built-in's own line-start menu: let core answer.
			if (!token || (cursorLine === 0 && token.start === 0)) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const items = toItems(matchCommands(inlineCommands(pi), token.query));
			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { items, prefix: `/${token.query}` };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			// Mid-sentence the built-in would treat a `/` prefix as a path, so replace it here.
			// Only for our own items: ours carry the slash in `value` (see `toItems`),
			// the built-in's do not and its own applyCompletion adds it — rebuilding from
			// those would drop the slash, which is what line start hands us.
			if (!prefix.startsWith("/") || !item.value.startsWith("/") || !line.slice(0, cursorCol).endsWith(prefix)) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			const start = cursorCol - prefix.length;
			const after = line.slice(cursorCol);
			// At the end of the line a trailing space saves a keystroke; mid-text the
			// existing character after the cursor is the separator.
			const insert = after === "" ? `${item.value} ` : item.value;
			const next = [...lines];
			next[cursorLine] = line.slice(0, start) + insert + after;
			return { lines: next, cursorLine, cursorCol: start + insert.length };
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

/** The live editor, as far as this extension needs to see it. */
type LiveEditor = {
	handleInput(data: string): void;
	state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
	tryTriggerAutocomplete?: () => void;
};

/** Text before the cursor, read from the editor. `undefined` for an editor we do not understand. */
function textBeforeCursor(editor: LiveEditor): string | undefined {
	const { lines, cursorLine, cursorCol } = editor.state ?? {};
	if (!lines || cursorLine === undefined || cursorCol === undefined) return undefined;
	const line = lines[cursorLine];
	return typeof line === "string" ? line.slice(0, cursorCol) : undefined;
}

/**
 * Wrap the editor so a typed letter can open the menu.
 *
 * Pi's editor decides on its own when to ask the provider: `/` auto-opens only
 * at the start of the first line (`isAtStartOfMessage`), and letters only while
 * the line already starts with `/`. Middle of a sentence it asks nobody, so a
 * provider alone cannot make the menu appear — the keystroke has to be caught
 * here and handed to the editor's own trigger.
 */
function withInlineTrigger(base: object, onKeystroke: (data: string) => void): object {
	return new Proxy(base, {
		get(target, property, receiver) {
			if (property === "handleInput") {
				return (data: string) => {
					Reflect.get(target, "handleInput")?.call(target, data);
					onKeystroke(data);
				};
			}
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
}

/** Install the keystroke trap. Does nothing when there is no editor to wrap (e.g. RPC mode). */
function installAutoOpen(pi: ExtensionAPI, ui: ExtensionContext["ui"]): void {
	const previous: EditorFactory | undefined = ui.getEditorComponent();
	if (!previous) return;

	ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		const base = previous(tui, theme, keybindings);
		const live = base as unknown as LiveEditor;

		return withInlineTrigger(base, (data: string) => {
			// Only a single name character can complete an inline token.
			if (data.length !== 1 || !/[A-Za-z0-9_-]/.test(data)) return;

			const before = textBeforeCursor(live);
			if (before === undefined) return;
			const token = inlineToken(before);
			// Wait for the first letter after the slash, and only open the menu when a
			// command actually matches — otherwise `/usr` would pop file suggestions.
			if (!token || token.query === "" || data.toLowerCase() !== token.query.slice(-1).toLowerCase()) return;
			if (matchCommands(inlineCommands(pi), token.query).length === 0) return;

			live.tryTriggerAutocomplete?.();
		}) as EditorComponent;
	});
}

export default function inlineSlash(pi: ExtensionAPI): void {
	pi.on("input", (event): InputEventResult => {
		if (event.source !== "interactive") return { action: "continue" };
		const text = event.text;
		if (!text || text.startsWith("/") || !text.includes("/")) return { action: "continue" };

		const { text: replaced, skills } = applyInline(text, loadRegistry(pi));
		if (replaced === undefined && skills.length === 0) return { action: "continue" };

		// Skills go in front, the way pi itself injects them; templates stay where they were written.
		const body = replaced ?? text;
		const blocks = skills.map(skillBlock).join("\n\n");
		return { action: "transform", text: blocks ? `${blocks}\n\n${body}` : body, images: event.images };
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => createInlineSlashProvider(current, pi));
		if (ctx.hasUI) installAutoOpen(pi, ctx.ui);
	});
}
