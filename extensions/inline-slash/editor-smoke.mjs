#!/usr/bin/env node
// Smoke-check against the real pi-tui editor.
//
// Pi's editor decides on its own when to ask a provider for suggestions, so the
// unit tests in check.mjs prove nothing about the menu actually opening. This
// drives a real editor the way pi does: load the extension through pi's own jiti
// loader, wrap the editor factory the way pi calls it, then type.
//
// It also guards the one private thing the extension touches: `tryTriggerAutocomplete`
// and `state` on the live editor. If a pi upgrade renames them, this fails.
//
// Usage: node extensions/inline-slash/editor-smoke.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "index.ts");

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
};

// ── load the extension the way pi does ──
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

const tui = await import(
	pathToFileURL(path.join(piPkg, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href
);
const { createJiti } = await import(
	pathToFileURL(path.join(piPkg, "node_modules", "jiti", "lib", "jiti.mjs")).href
);
const alias = {};
for (const name of readdirSync(path.join(piPkg, "node_modules", "@earendil-works"))) {
	alias[`@earendil-works/${name}`] = path.join(piPkg, "node_modules", "@earendil-works", name);
}
alias["@earendil-works/pi-coding-agent"] = piPkg;
const extension = await createJiti(ENTRY, { alias }).import(pathToFileURL(ENTRY).href);

const scratch = mkdtempSync(path.join(tmpdir(), "inline-slash-"));
const templateFile = path.join(scratch, "p-fact-check.md");
writeFileSync(templateFile, "---\ndescription: 核对事实\n---\n核对事实，标注不确定处。$@\n");
const skillDir = path.join(scratch, "code-review");
mkdirSync(skillDir, { recursive: true });
const skillFile = path.join(skillDir, "SKILL.md");
writeFileSync(skillFile, "---\ndescription: 审代码\n---\n先读代码，再给结论。\n");

const COMMANDS = [
	{ name: "p-fact-check", description: "核对事实", source: "prompt", sourceInfo: { path: templateFile } },
	{ name: "p-fact-check-deep", description: "深度核对", source: "prompt", sourceInfo: { path: templateFile } },
	{
		name: "skill:code-review",
		description: "审代码",
		source: "skill",
		sourceInfo: { path: skillFile, baseDir: skillDir },
	},
];

// ── fake pi host with a provider list and an editor factory stack, like pi's ──
const handlers = new Map();
const providerWrappers = [];
const fakeTui = { requestRender: () => {}, terminal: { rows: 30 } };
const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
const defaultFactory = (tuiArg, themeArg) => new tui.Editor(tuiArg, themeArg, undefined);
let factory = defaultFactory;
const ui = {
	addAutocompleteProvider: (make) => providerWrappers.push(make),
	getEditorComponent: () => factory,
	setEditorComponent: (next) => {
		factory = next;
	},
};
const pi = {
	on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	registerCommand: () => {},
	registerTool: () => {},
	getCommands: () => COMMANDS,
};

await extension.default(pi);
for (const handler of handlers.get("session_start") ?? []) {
	await handler({ type: "session_start" }, { hasUI: true, ui });
}
check("the extension wraps the editor factory", factory !== defaultFactory);
check("it registers one autocomplete provider", providerWrappers.length === 1);

const base = new tui.CombinedAutocompleteProvider(
	COMMANDS.map((command) => ({ name: command.name, description: command.description })),
	process.cwd(),
	null,
);
const editor = factory(fakeTui, theme, {});
editor.setAutocompleteProvider(providerWrappers.reduce((provider, make) => make(provider), base));

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const type = async (text) => {
	for (const char of text) {
		editor.handleInput(char);
		await settle();
	}
};
const items = () => editor.autocompleteList?.items?.map((item) => item.value) ?? [];

console.log("\n── the menu ──");
await type("用 /p-fact");
check("opens mid-sentence", editor.isShowingAutocomplete(), JSON.stringify(items()));
check("lists the templates, not the skill", JSON.stringify(items()) === '["/p-fact-check","/p-fact-check-deep"]');

editor.handleInput("\t");
await settle();
check("Tab accepts the highlighted template", editor.getText() === "用 /p-fact-check ");

editor.setText("");
await type("用 /skill:co");
check("completes skills too", JSON.stringify(items()) === '["/skill:code-review"]');

console.log("\n── what pi receives ──");
const onInput = handlers.get("input")[0];
const sent = await onInput({ type: "input", source: "interactive", text: "用 /p-fact-check 看这个 /skill:code-review" }, {});
check("a template is replaced in place", sent.text?.includes("用 核对事实，标注不确定处。 看这个"), sent.text);
check(
	"a skill is injected in front",
	sent.text?.startsWith(`<skill name="code-review" location="${skillFile}">`) &&
		sent.text.includes(`References are relative to ${skillDir}.`),
);
check("the sentence survives", sent.text?.endsWith("用 核对事实，标注不确定处。 看这个 /skill:code-review"));

editor.setText("");
await type("/p-fact");
check("line start keeps the built-in menu", JSON.stringify(items()) === '["p-fact-check","p-fact-check-deep"]');
editor.handleInput("\t");
await settle();
check("line start accepts without losing the slash", editor.getText() === "/p-fact-check ", JSON.stringify(editor.getText()));

editor.setText("");
await type("看 /usr/local");
check("a path stays quiet", !editor.isShowingAutocomplete());

editor.setText("");
await type("first\n/p-fact");
check("works on the second line", editor.isShowingAutocomplete());

console.log(failures === 0 ? "\nok" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
