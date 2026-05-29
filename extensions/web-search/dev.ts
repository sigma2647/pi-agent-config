#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
import { registerBackend, runChain, loadConfig, listBackends } from "./chain.ts";
import { braveBackend } from "./backends/brave.ts";
import { opencliBackend } from "./backends/opencli.ts";
import { browserBackend } from "./backends/browser.ts";

registerBackend(braveBackend);
registerBackend(opencliBackend);
registerBackend(browserBackend);

const USAGE = `usage:
  pi-ws <query>                  full chain (brave → opencli → browser)
                                 default output is JSON (matches what the pi
                                 web_search agent tool returns, easy to pipe
                                 into jq).
  pi-ws --human <query>          human-readable output (numbered list)
  pi-ws --format json|human ...  same idea, explicit form
  pi-ws --instant <query>        return first available backend's results
  pi-ws --chain a,b <query>      override fallback chain for this call
  pi-ws --list                   list registered backends + effective chain
  pi-ws --json <query>           alias for --format json (kept for muscle memory)
env:
  PI_WS_FORMAT=human|json          override CLI default output format
  PI_WEB_SEARCH_CHAIN              "brave,opencli,browser"
  PI_WEB_SEARCH_TOTAL_TIMEOUT      ms, default 15000
  PI_WEB_SEARCH_TIMEOUT_<BACKEND>  per-backend, ms
  BRAVE_SEARCH_API_KEY             required for the brave backend
`;

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
	process.stderr.write(USAGE);
	process.exit(args.length === 0 ? 1 : 0);
}

if (args[0] === "--list") {
	const cfg = loadConfig();
	console.log("registered:", listBackends().join(", ") || "(none)");
	console.log("chain:     ", cfg.chain.join(" → ") || "(empty)");
	console.log("totalMs:   ", cfg.totalTimeoutMs);
	console.log("perBackend:", JSON.stringify(cfg.perBackendTimeoutMs));
	process.exit(0);
}

function dieFlagNeedsArg(flag: string, hint: string): never {
	process.stderr.write(`error: ${flag} requires an argument\n${hint}\n`);
	process.exit(2);
}

let mode: "full" | "instant" = "full";
let chain: string[] | undefined;
// Default: JSON. Override via --human / --format human or PI_WS_FORMAT=human.
const envFmt = (process.env.PI_WS_FORMAT ?? "").toLowerCase();
let format: "json" | "human" = envFmt === "human" ? "human" : "json";
let query: string | undefined;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--instant") mode = "instant";
	else if (a === "--json") format = "json";
	else if (a === "--human") format = "human";
	else if (a === "--format") {
		const next = args[i + 1];
		if (next !== "json" && next !== "human") {
			dieFlagNeedsArg("--format", `accepted values: json, human\nexample:\n  pi-ws --format json "your query"`);
		}
		format = next;
		i++;
	}
	else if (a === "--chain") {
		const next = args[i + 1];
		if (next === undefined || next.startsWith("-")) {
			const available = listBackends();
			const cfg = loadConfig();
			dieFlagNeedsArg(
				"--chain",
				`available backends: ${available.join(", ") || "(none registered)"}\n` +
				`current chain:     ${cfg.chain.join(" → ") || "(empty)"}\n` +
				`example:\n` +
				`  pi-ws --chain brave,opencli "your query"\n` +
				`  pi-ws --chain ${available[0] ?? "brave"} "your query"`,
			);
		}
		chain = next.split(",").map((s) => s.trim()).filter(Boolean);
		i++; // consume the value
		// Validate names early so the error is obvious rather than silently dropped.
		const known = listBackends();
		const unknown = chain.filter((n) => !known.includes(n));
		if (unknown.length > 0) {
			process.stderr.write(
				`error: unknown backend(s): ${unknown.join(", ")}\n` +
				`available: ${known.join(", ")}\n`,
			);
			process.exit(2);
		}
	}
	// Catch unknown `--flag` early — otherwise it silently appends to the
	// query and the user gets surprising results ("you searched for `你好
	// --format json`"). Bare values still go to query.
	else if (a.startsWith("--")) {
		process.stderr.write(`error: unknown flag: ${a}\n${USAGE}`);
		process.exit(2);
	}
	else if (!query) query = a;
	else query += " " + a;
}

if (!query) {
	process.stderr.write(USAGE);
	process.exit(1);
}

const ctrl = new AbortController();
process.on("SIGINT", () => ctrl.abort());

const result = await runChain(query, ctrl.signal, {
	chain,
	shortCircuit: mode === "instant",
});

if (format === "json") {
	console.log(JSON.stringify(result, null, 2));
	process.exit(result.kind === "ok" ? 0 : 1);
}

if (result.kind === "ok") {
	console.error(`[backend: ${result.backend}] (${result.results.length} results)\n`);
	result.results.forEach((r, i) => {
		console.log(`${i + 1}. ${r.title}`);
		console.log(`   ${r.url}`);
		if (r.snippet) console.log(`   ${r.snippet}`);
		console.log();
	});
} else {
	console.error(`Web search failed for "${query}". Backends tried:`);
	for (const a of result.attempts) {
		const tag =
			a.status.kind === "skipped" ? "SKIPPED" :
			a.status.kind === "failed"  ? "FAILED"  :
			a.status.kind === "empty"   ? "EMPTY"   : "OK";
		const reason = a.status.kind === "ok" ? `${a.status.results.length} results` : a.status.reason;
		console.error(`  - ${a.name}: ${tag} (${reason}) [${a.elapsedMs}ms]`);
	}
	process.exit(1);
}
