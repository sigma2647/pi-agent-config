#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
// pi-ws --smoke — quick end-to-end self-check.
//
// Runs 2 cases against the installed pi-ws CLI, asserting exit code +
// valid JSON + results.length >= minResults. ~3-8s on happy path.
// case 2 (force-opencli) SKIPs if opencli is not on PATH.

import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { which } from "./cli-helpers.ts";

const execFileP = promisify(execFile);

interface SmokeCase {
	id: string;
	args: string[];
	minResults: number;
	skipIf?: () => Promise<boolean>;
}

interface CaseResult {
	id: string;
	status: "PASS" | "FAIL" | "SKIP";
	resultCount: number;
	elapsedMs: number;
	reason?: string;
	stderrHead?: string;
}

const CASES: SmokeCase[] = [
	{
		id: "default-chain",
		args: ["wikipedia HTTP RFC"],
		minResults: 3,
	},
	{
		id: "force-opencli",
		args: ["--chain", "opencli", "wikipedia HTTP RFC"],
		minResults: 3,
		skipIf: async () => (await which("opencli")) === null,
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
		return { id: c.id, status: "SKIP", resultCount: 0, elapsedMs: 0, reason: "opencli not on PATH" };
	}
	const t0 = Date.now();
	const remaining = deadline - t0;
	if (remaining <= 0) {
		return { id: c.id, status: "FAIL", resultCount: 0, elapsedMs: 0, reason: "total timeout exhausted" };
	}
	const timeout = Math.min(PER_CASE_TIMEOUT_MS, remaining);
	try {
		const { stdout, stderr } = await execFileP("pi-ws", c.args, {
			timeout,
			maxBuffer: 20 * 1024 * 1024,
		});
		const elapsedMs = Date.now() - t0;
		const stderrHead = stderr.split("\n").slice(0, 2).join("\n");
		let parsed: any;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			return { id: c.id, status: "FAIL", resultCount: 0, elapsedMs,
				reason: "stdout not valid JSON", stderrHead };
		}
		if (parsed.kind !== "ok") {
			return { id: c.id, status: "FAIL", resultCount: 0, elapsedMs,
				reason: `kind=${parsed.kind ?? "?"}`, stderrHead };
		}
		const count = Array.isArray(parsed.results) ? parsed.results.length : 0;
		if (count < c.minResults) {
			return { id: c.id, status: "FAIL", resultCount: count, elapsedMs,
				reason: `results=${count} < min=${c.minResults}`, stderrHead };
		}
		return { id: c.id, status: "PASS", resultCount: count, elapsedMs };
	} catch (err: any) {
		const elapsedMs = Date.now() - t0;
		const isTimeout = err.killed === true && (err.signal === "SIGTERM" || err.code === null);
		const reason = isTimeout ? `timeout after ${timeout}ms` : `exit=${err.code ?? "?"}`;
		const stderrHead = (err.stderr ?? "").toString().split("\n").slice(0, 2).join("\n");
		return { id: c.id, status: "FAIL", resultCount: 0, elapsedMs, reason, stderrHead };
	}
}

export async function runSmoke(): Promise<number> {
	const piws = await which("pi-ws");
	if (!piws) {
		process.stderr.write("error: pi-ws not found on PATH — run extensions/install.sh\n");
		return 1;
	}

	console.log("pi-ws smoke:\n");
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
		const cnt = r.resultCount ? `${r.resultCount} hits` : "—";
		const t = r.elapsedMs ? `${(r.elapsedMs / 1000).toFixed(1)}s` : "—";
		const tail = r.reason ? `  ${Y}${r.reason}${NC}` : "";
		console.log(`  ${tag}  ${r.id.padEnd(20)} ${cnt.padStart(8)}  ${t.padStart(5)}${tail}`);
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
		console.log("\n  Hint: run pi-ws --doctor to triage env");
		return 1;
	}
	return 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	process.exit(await runSmoke());
}
