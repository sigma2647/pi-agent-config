// Self-check for the inline-slash extension. Run: node check.mjs
import assert from "node:assert/strict";
import {
	applyInline,
	createInlineSlashProvider,
	inlineToken,
	scanTokens,
	skillBlock,
	stripFrontmatter,
	withoutArgs,
} from "./index.ts";

const registry = new Map([
	["p-fact-check", { name: "p-fact-check", kind: "prompt", body: "核对事实，标注不确定处。" }],
	[
		"p-expert-panel",
		{ name: "p-expert-panel", kind: "prompt", body: "召集专家会诊：$@\n主线：${1:-默认议题}" },
	],
	[
		"skill:code-review",
		{ name: "skill:code-review", kind: "skill", body: "先读代码，再给结论。", path: "/s/code-review/SKILL.md", baseDir: "/s/code-review" },
	],
]);

const textCases = [
	// [input, expected text]
	["用 /p-fact-check 检查这段", "用 核对事实，标注不确定处。 检查这段"],
	["a /unknown-token b", undefined],
	["看 /home/me/file.ts", undefined],
	["看 `code /p-fact-check here`", undefined],
	["```\n/p-fact-check\n```", undefined],
	[
		"A /p-fact-check B `x` C /p-fact-check D",
		"A 核对事实，标注不确定处。 B `x` C 核对事实，标注不确定处。 D",
	],
	["（/p-fact-check）", "（核对事实，标注不确定处。）"],
	// Skills are not substituted, they are collected.
	["用 /skill:code-review 看看", undefined],
];

for (const [input, expected] of textCases) {
	assert.equal(applyInline(input, registry).text, expected, `input: ${input}`);
}

assert.deepEqual(
	applyInline("用 /skill:code-review 看看", registry).skills.map((s) => s.name),
	["skill:code-review"],
);
assert.deepEqual(
	applyInline("用 /skill:code-review 和 /skill:code-review", registry).skills.map((s) => s.name),
	["skill:code-review"],
	"a repeated skill is injected once",
);
assert.deepEqual(applyInline("用 /skill:unknown", registry).skills, []);

assert.equal(stripFrontmatter("---\ndescription: x\n---\nBody\n"), "Body\n");
assert.equal(stripFrontmatter("no frontmatter"), "no frontmatter");
assert.equal(withoutArgs("召集专家会诊：$@\n主线：${1:-默认议题}"), "召集专家会诊：\n主线：默认议题");

assert.equal(
	skillBlock(registry.get("skill:code-review")),
	'<skill name="code-review" location="/s/code-review/SKILL.md">\nReferences are relative to /s/code-review.\n\n先读代码，再给结论。\n</skill>',
);

// --- token scanning ---
assert.deepEqual(scanTokens("用 /p-fact").map((token) => token.name), ["p-fact"]);
assert.deepEqual(scanTokens("用 /skill:code-review").map((token) => token.name), ["skill:code-review"]);
assert.deepEqual(scanTokens("看 /usr/local"), []);

// --- token detection for the menu ---
assert.deepEqual(inlineToken("用 /p-fact"), { query: "p-fact", start: 2 });
assert.deepEqual(inlineToken("用 /"), { query: "", start: 2 });
assert.deepEqual(inlineToken("/p-fact"), { query: "p-fact", start: 0 });
assert.deepEqual(inlineToken("用 /skill:code"), { query: "skill:code", start: 2 });
assert.equal(inlineToken("看 /usr/local"), undefined);
assert.equal(inlineToken("看 /p-fact 后"), undefined);
assert.deepEqual(inlineToken("（/p-fact"), { query: "p-fact", start: 1 });

// --- completion provider ---
const fakePi = {
	getCommands: () => [
		{ name: "p-fact-check", description: "核对事实", source: "prompt", sourceInfo: {} },
		{ name: "p-expert-panel", source: "prompt", sourceInfo: {} },
		{ name: "skill:code-review", description: "审代码", source: "skill", sourceInfo: {} },
	],
};
const passthrough = {
	getSuggestions: async () => null,
	applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
	shouldTriggerFileCompletion: () => true,
};
const provider = createInlineSlashProvider(passthrough, fakePi);
const signal = new AbortController().signal;

const mid = "用 /p-fact 看这段";
const midCol = "用 /p-fact".length;
const suggestions = await provider.getSuggestions([mid], 0, midCol, { signal });
assert.equal(suggestions.prefix, "/p-fact");
assert.deepEqual(
	suggestions.items.map((item) => item.value),
	["/p-fact-check"],
);
assert.equal(suggestions.items[0].description, "核对事实");

const applied = provider.applyCompletion([mid], 0, midCol, suggestions.items[0], suggestions.prefix);
assert.equal(applied.lines[0], "用 /p-fact-check 看这段");

const atEnd = provider.applyCompletion(["用 /p-fact"], 0, "用 /p-fact".length, suggestions.items[0], "/p-fact");
assert.equal(atEnd.lines[0], "用 /p-fact-check ");

// A bare name still finds the skill, and the replacement covers only the typed part.
const bare = await provider.getSuggestions(["用 /code"], 0, "用 /code".length, { signal });
assert.deepEqual(
	bare.items.map((item) => item.value),
	["/skill:code-review"],
);
assert.equal(
	provider.applyCompletion(["用 /code"], 0, "用 /code".length, bare.items[0], bare.prefix).lines[0],
	"用 /skill:code-review ",
);

// Line start belongs to the built-in menu — and to the built-in's applyCompletion:
// its items carry no slash (it adds the slash itself), so rebuilding from them would
// drop it. Ours must hand the keystroke back.
assert.equal(await provider.getSuggestions(["/p"], 0, 2, { signal }), null);
const delegated = [];
const builtin = {
	getSuggestions: async () => null,
	applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
		delegated.push(prefix);
		return { lines: [`/${item.value} `], cursorLine, cursorCol };
	},
	shouldTriggerFileCompletion: () => true,
};
const lineStart = createInlineSlashProvider(builtin, fakePi);
assert.deepEqual(
	lineStart.applyCompletion(["/p-fact"], 0, 7, { value: "p-fact-check" }, "/p-fact"),
	{ lines: ["/p-fact-check "], cursorLine: 0, cursorCol: 7 },
);
assert.deepEqual(delegated, ["/p-fact"]);
// Path-like input is not a token.
assert.equal(await provider.getSuggestions(["看 /usr/local"], 0, 13, { signal }), null);

console.log("ok — inline rewrite, skills, token scan, completion");
