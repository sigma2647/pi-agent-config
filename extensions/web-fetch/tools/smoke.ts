#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
// pi-wf --smoke — quick end-to-end self-check.
//
// Runs 3 cases against the installed pi-wf CLI as subprocess, asserting
// exit code + output size + key pattern. ~5s total on happy path. Sits
// between --doctor (env triage) and tests/stress.sh (regression).

import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { which } from "./cli-helpers.ts";

const execFileP = promisify(execFile);

interface SmokeCase {
	id: string;
	args: string[];
	minBytes: number;
	pattern: RegExp;
	skipIf?: () => Promise<boolean>;
}

interface CaseResult {
	id: string;
	status: "PASS" | "FAIL" | "SKIP";
	bytes: number;
	elapsedMs: number;
	reason?: string;
	stderrHead?: string;
}

const CASES: SmokeCase[] = [
	{
		id: "wiki-defuddle",
		args: ["https://en.wikipedia.org/wiki/HTTP"],
		minBytes: 2048,
		pattern: /Hypertext Transfer/,
	},
	{
		id: "github-readme",
		args: ["https://github.com/anthropics/claude-code"],
		minBytes: 500,
		pattern: /anthropics\/claude-code/,
	},
	{
		id: "hn-item",
		args: ["https://news.ycombinator.com/item?id=39000000"],
		minBytes: 200,
		pattern: /HN item/,
	},
];

const PER_CASE_TIMEOUT_MS = 15000;
const TOTAL_TIMEOUT_MS = 30000;

const useColor = process.stdout.isTTY === true;
const G = useColor ? "\x1b[32m" : "";
const R = useColor ? "\x1b[31m" : "";
const Y = useColor ? "\x1b[33m" : "";
const NC = useColor ? "\x1b[0m" : "";

async function runCase(c: SmokeCase, deadline: number): Promise<CaseResult> {
	if (c.skipIf && (await c.skipIf())) {
		return { id: c.id, status: "SKIP", bytes: 0, elapsedMs: 0, reason: "dep missing" };
	}
	const t0 = Date.now();
	const remaining = deadline - t0;
	if (remaining <= 0) {
		return { id: c.id, status: "FAIL", bytes: 0, elapsedMs: 0, reason: "total timeout exhausted" };
	}
	const timeout = Math.min(PER_CASE_TIMEOUT_MS, remaining);
	try {
		const { stdout, stderr } = await execFileP("pi-wf", c.args, {
			timeout,
			maxBuffer: 20 * 1024 * 1024,
		});
		const elapsedMs = Date.now() - t0;
		const bytes = Buffer.byteLength(stdout, "utf8");
		const stderrHead = stderr.split("\n").slice(0, 2).join("\n");
		if (bytes < c.minBytes) {
			return { id: c.id, status: "FAIL", bytes, elapsedMs,
				reason: `size=${bytes}B < min=${c.minBytes}B`, stderrHead };
		}
		if (!c.pattern.test(stdout)) {
			return { id: c.id, status: "FAIL", bytes, elapsedMs,
				reason: `pattern not found: ${c.pattern.source}`, stderrHead };
		}
		return { id: c.id, status: "PASS", bytes, elapsedMs };
	} catch (err: any) {
		const elapsedMs = Date.now() - t0;
		const isTimeout = err.killed === true && (err.signal === "SIGTERM" || err.code === null);
		const reason = isTimeout ? `timeout after ${timeout}ms` : `exit=${err.code ?? "?"}`;
		const stderrHead = (err.stderr ?? "").toString().split("\n").slice(0, 2).join("\n");
		return { id: c.id, status: "FAIL", bytes: 0, elapsedMs, reason, stderrHead };
	}
}

export async function runSmoke(): Promise<number> {
	const piwf = await which("pi-wf");
	if (!piwf) {
		process.stderr.write("error: pi-wf not found on PATH — run extensions/install.sh\n");
		return 1;
	}

	console.log("pi-wf smoke:\n");
	const wallStart = Date.now();
	const deadline = wallStart + TOTAL_TIMEOUT_MS;
	const results: CaseResult[] = [];
	for (const c of CASES) {
		const r = await runCase(c, deadline);
		results.push(r);
		const tag =
			r.status === "PASS" ? `${G}PASS${NC}` :
			r.status === "FAIL" ? `${R}FAIL${NC}` :
			                      `${Y}SKIP${NC}`;
		const size = r.bytes ? `${r.bytes}B` : "—";
		const t = r.elapsedMs ? `${(r.elapsedMs / 1000).toFixed(1)}s` : "—";
		const tail = r.reason ? `  ${Y}${r.reason}${NC}` : "";
		console.log(`  ${tag}  ${r.id.padEnd(20)} ${size.padStart(6)}  ${t.padStart(5)}${tail}`);
		if (r.stderrHead) {
			for (const line of r.stderrHead.split("\n")) {
				if (line) console.log(`        | ${line}`);
			}
		}
	}

	const wallMs = Date.now() - wallStart;
	const pass = results.filter((r) => r.status === "PASS").length;
	const fail = results.filter((r) => r.status === "FAIL").length;
	const skip = results.filter((r) => r.status === "SKIP").length;
	console.log(`\n  pass=${G}${pass}${NC}  fail=${R}${fail}${NC}  skip=${Y}${skip}${NC}  wall=${(wallMs / 1000).toFixed(1)}s`);
	if (fail > 0) {
		console.log("\n  Hint: run pi-wf --doctor to triage env");
		return 1;
	}
	return 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	process.exit(await runSmoke());
}
