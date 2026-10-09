#!/usr/bin/env node
// Smoke-check: run the extension the way pi does, with pi's own jiti loader.
//
// `index.ts` never runs under `node --test` (it imports pi), and its wiring is
// where a mistake takes the whole pi process down — the first version crashed pi
// with `theme.fg is not a function`. So: fake the pi host, start a session, press
// Ctrl+R, drive the floating panel and check what lands in the editor.
//
// Usage: node extensions/prompt-history/test/editor-smoke.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "index.ts");

// Point pi's agent dir at an empty directory before the extension is loaded, so
// `loadRecentPrompts` has no sessions to read and the pool is only what this
// test injects.
process.env.PI_CODING_AGENT_DIR = await mkdtemp(path.join(tmpdir(), "ph-smoke-"));

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
};
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

// ── Locate the installed pi package and load the entry through its jiti ──
let bin;
try {
	bin = execFileSync("/bin/sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
} catch {
	/* empty */
}
if (!bin) {
	console.error("✗ pi not on PATH — cannot load the extension the way pi does");
	process.exit(1);
}
let piPkg = path.dirname(realpathSync(bin));
while (piPkg !== "/" && !existsSync(path.join(piPkg, "package.json"))) piPkg = path.dirname(piPkg);
const { createJiti } = await import(
	pathToFileURL(path.join(piPkg, "node_modules", "jiti", "lib", "jiti.mjs")).href
);
const alias = {};
for (const name of readdirSync(path.join(piPkg, "node_modules", "@earendil-works"))) {
	alias[`@earendil-works/${name}`] = path.join(piPkg, "node_modules", "@earendil-works", name);
}
alias["@earendil-works/pi-coding-agent"] = piPkg;
const jiti = createJiti(path.join(HERE, "editor-smoke.ts"), { alias });

const extension = await jiti.import(pathToFileURL(ENTRY).href);

// ── A pi host small enough to reason about ──
// `getEditorComponent` hands back a plain editor, so no real CustomEditor or TUI
// is ever constructed.
const CTRL_R = "\u001b[114;5u"; // the Kitty encoding ghostty sends
// Kitty encodings for the emacs keys, so the test presses what a real terminal sends.
const CTRL_A = "\u001b[97;5u";
const CTRL_E = "\u001b[101;5u";
const CTRL_J = "\u001b[106;5u";
const CTRL_K = "\u001b[107;5u";
const CTRL_N = "\u001b[110;5u";
const CTRL_P = "\u001b[112;5u";
const ENTRIES = [
	{ type: "message", message: { role: "user", content: "alpha one" } },
	{ type: "message", message: { role: "assistant", content: "not a prompt" } },
	{ type: "message", message: { role: "user", content: ["with", " parts"].join("") } },
	{ type: "message", message: { role: "user", content: "Add retry backoff and jitter to the worker" } },
];

const makeHost = (rows = 30) => {
	const handlers = new Map();
	const state = {
		editorText: "seed draft",
		overlayOptions: undefined,
		component: undefined,
		panelRows: undefined,
		requested: 0,
		baseInput: [],
		notices: [],
	};

	const fakeBase = {
		getText: () => state.editorText,
		setText: (text) => {
			state.editorText = text;
		},
		addToHistory: () => {},
		invalidate: () => {},
		handleInput: (data) => state.baseInput.push(data),
		render: (width) => ["─".repeat(width), " ".repeat(width), "─".repeat(width)],
	};
	const tui = { requestRender: () => (state.requested += 1), terminal: { rows } };
	const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
	const ui = {
		getEditorComponent: () => () => fakeBase,
		setEditorComponent: (factory) => {
			state.editorFactory = factory;
		},
		setEditorText: (text) => {
			state.editorText = text;
		},
		getEditorText: () => state.editorText,
		notify: (message) => state.notices.push(message),
		custom: (factory, options) => {
			state.overlayOptions = options;
			return new Promise((resolve) => {
				state.component = factory(tui, theme, {}, resolve);
			});
		},
	};
	const pi = {
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerShortcut: () => {},
		registerCommand: () => {},
		registerTool: () => {},
	};
	const ctx = {
		hasUI: true,
		cwd: "/tmp",
		sessionManager: { getBranch: () => ENTRIES },
		ui,
	};
	return { pi, ctx, handlers, state, tui, theme };
};

const start = async (rows = 30, draft = "seed draft") => {
	const host = makeHost(rows);
	host.state.editorText = draft;
	await extension.default(host.pi);
	for (const handler of host.handlers.get("session_start") ?? []) await handler({ type: "session_start" }, host.ctx);
	host.state.editor = host.state.editorFactory(host.tui, {}, {});
	return host;
};

console.log("── wiring ──");
{
	const host = await start();
	const editor = host.state.editor;
	check("the editor wrapper installs itself", typeof editor?.handleInput === "function");
	check("idle keys reach the editor underneath", (editor.handleInput("x"), host.state.baseInput.join("") === "x"));
	check(
		"idle renders pass the editor frame through",
		editor.render(20).length === 3 && editor.render(20)[0] === "─".repeat(20),
	);

	editor.handleInput(CTRL_R);
	const options = host.state.overlayOptions;
	check("Ctrl+R opens a floating overlay", options?.overlay === true, JSON.stringify(options?.overlayOptions));
	check("the overlay is anchored above the prompt box", options?.overlayOptions?.anchor === "bottom-center");
	check("Ctrl+R is not forwarded to the editor", !host.state.baseInput.includes(CTRL_R));
}

console.log("\n── the panel ──");
{
	const host = await start();
	host.state.editor.handleInput(CTRL_R);
	const panel = host.state.component;
	const rows = panel.render(60);
	check("the panel draws a titled box", strip(rows[0] ?? "").startsWith("╭─ History Search "), strip(rows[0] ?? ""));
	check("every row fits the width", rows.every((row) => strip(row).length === 60));
	check("no row holds a newline", rows.every((row) => !row.includes("\n")));
	check("the draft seeds the query", strip(rows[1] ?? "").includes("> seed draft"));
	check("a draft that matches nothing says so", strip(rows[3] ?? "").includes("no match"), strip(rows[3] ?? ""));
	console.log(rows.join("\n"));

	for (let index = 0; index < "seed draft".length; index += 1) panel.handleInput("\x7f");
	const cleared = panel.render(60);
	check("clearing the query lists the whole pool", strip(cleared[1] ?? "").includes("[1/3]"), strip(cleared[1] ?? ""));
	check("the box hugs the results", cleared.length === 3 + 7, `${cleared.length} rows`);
	console.log(cleared.join("\n"));

	for (const char of "ret") panel.handleInput(char);
	const filtered = panel.render(60);
	check("typing filters the list", strip(filtered[1] ?? "").includes("[1/1]"), strip(filtered[1] ?? ""));
	check("the match is highlighted", filtered.some((row) => row.includes("\x1b[4m")));
	console.log(filtered.join("\n"));

	panel.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	check(
		"Enter writes the match into the editor",
		host.state.editorText === "Add retry backoff and jitter to the worker",
		JSON.stringify(host.state.editorText),
	);
	check("accepting repaints the editor", host.state.requested > 0);
}

console.log("\n── emacs keys ──");
{
	const host = await start(30, "");
	host.state.editor.handleInput(CTRL_R);
	const panel = host.state.component;
	const queryRow = () => strip(panel.render(60)[1] ?? "");
	const counter = () => /\[(\d+)\//.exec(queryRow())?.[1];
	const press = (data) => panel.handleInput(data);

	check("C-n moves to the next match", (press(CTRL_N), counter() === "2"), `[${counter()}/3]`);
	check("C-p moves back", (press(CTRL_P), counter() === "1"), `[${counter()}/3]`);

	for (const char of "abc") press(char);
	check("typing lands at the cursor", queryRow().includes("> abc▌"), queryRow());
	press(CTRL_A);
	check("C-a puts the cursor at the line start", queryRow().includes("> ▌abc"), queryRow());
	press(CTRL_E);
	check("C-e puts it back at the line end", queryRow().includes("> abc▌"), queryRow());
	press(CTRL_A);
	press(CTRL_K);
	check("C-k kills from the cursor to the end", !queryRow().includes("abc"), queryRow());

	for (const char of "ret") press(char);
	press(CTRL_J);
	await new Promise((resolve) => setTimeout(resolve, 0));
	check(
		"C-j accepts like Enter",
		host.state.editorText === "Add retry backoff and jitter to the worker",
		JSON.stringify(host.state.editorText),
	);
}

console.log("\n── cancel and narrow terminals ──");
{
	const host = await start();
	host.state.editor.handleInput(CTRL_R);
	host.state.component.handleInput("\u001b");
	await new Promise((resolve) => setTimeout(resolve, 0));
	check("Esc leaves the draft alone", host.state.editorText === "seed draft", JSON.stringify(host.state.editorText));
}
{
	const host = await start(10);
	host.state.editor.handleInput(CTRL_R);
	const rows = host.state.component.render(40);
	check("a short terminal shrinks the list instead of overflowing", rows.length <= 10, `${rows.length} rows`);
	check("the box still closes", strip(rows.at(-1) ?? "").startsWith("╰"));
}

console.log(failures === 0 ? "\nall editor smoke checks passed" : `\n${failures} editor smoke check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
