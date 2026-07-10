import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { readVisiblePing, readVisibleSessionSummary } from "../visible-runtime.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("visible subagent ping", () => {
	it("returns a valid child help request and ignores malformed sidecars", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-ping-"));
		tempDirs.push(dir);
		const pingFile = join(dir, "child.ping.json");
		assert.equal(readVisiblePing(pingFile), null);
		writeFileSync(pingFile, JSON.stringify({ message: "Need the API token" }));
		assert.equal(readVisiblePing(pingFile), "Need the API token");
		writeFileSync(pingFile, "not json");
		assert.equal(readVisiblePing(pingFile), null);
	});

	it("prefers the final assistant message over terminal output", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-session-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(sessionFile, [
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "First draft" }] } }),
			JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "noisy tool output" }] } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "Final report" }] } }),
		].join("\n"));
		assert.equal(readVisibleSessionSummary(sessionFile), "Final report");
	});
});
