#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
// pi-ws --doctor — environment & backend self-check.
//
// Mirrors `pi-wf --doctor` but for the web-search chain. Prints a one-glance
// report of: Node version, the effective chain + timeouts, each registered
// backend's availability (via its own isAvailable()) plus an actionable hint,
// and the relevant env vars. Designed to answer "why does backend X get
// skipped?" without digging through AGENTS.md.

import { loadConfig, listBackends, registerDefaultBackends } from "../chain.ts";
import { OK, BAD, WARN, which, probeTcp } from "../../_common/tools/cli-helpers.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function section(title: string): void {
	console.log(`\n${BOLD}  ▸ ${title}${RESET}`);
}

function parseHostPort(url: string | undefined): { host: string; port: number } | null {
	if (!url) return null;
	try {
		const u = new URL(url);
		return { host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) };
	} catch {
		return null;
	}
}

function mask(secret: string): string {
	if (secret.length <= 8) return "****";
	return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
}

function pad(label: string, width: number): string {
	const plain = label.replace(/\x1b\[[0-9;]*m/g, "");
	return label + " ".repeat(Math.max(1, width - plain.length));
}

const COL1 = 20;

export async function runDoctor(): Promise<void> {
	// Populate the REGISTRY so the Chain section reports the real backends even
	// when doctor.ts is run standalone (e.g. `node tools/doctor.ts`); via
	// `pi-ws --doctor` dev.ts has already registered them — idempotent either way.
	registerDefaultBackends();
	console.log(`${BOLD}══ pi-ws doctor ══${RESET}`);

	// ── Runtime ──
	section("Runtime");
	const nodeOk = process.version >= "v22.6.0";
	console.log(`  ${pad("Node.js", COL1)} ${process.version}  ${nodeOk ? OK : WARN}${nodeOk ? "" : "  (need ≥22.6 for --experimental-strip-types)"}`);

	// ── Chain ──
	section("Chain");
	const cfg = loadConfig();
	console.log(`  ${pad("Registered", COL1)} ${listBackends().join(", ") || "(none)"}`);
	console.log(`  ${pad("Effective", COL1)} ${cfg.chain.join(" → ") || "(empty)"}`);
	console.log(`  ${pad("TotalTimeout", COL1)} ${cfg.totalTimeoutMs}ms`);

	// ── Backends ──
	section("Backends");

	// brave
	const braveKey = process.env.BRAVE_SEARCH_API_KEY ?? "";
	console.log(`  ${pad("brave", COL1)} ${braveKey ? OK + "  " + mask(braveKey) : BAD + "  BRAVE_SEARCH_API_KEY unset — backend skipped"}`);

	// opencli
	const opencli = await which("opencli");
	let opencliStatus = "";
	if (opencli) {
		try {
			const { promisify } = await import("node:util");
			const { execFile } = await import("node:child_process");
			const execFileP = promisify(execFile);
			const { stdout } = await execFileP("opencli", ["daemon", "status"], { timeout: 2000 });
			opencliStatus = stdout.includes("running") ? " (daemon running)" : " (daemon NOT running)";
		} catch {
			opencliStatus = " (daemon status unknown)";
		}
	}
	console.log(`  ${pad("opencli", COL1)} ${opencli ? OK + "  " + opencli + DIM + opencliStatus + RESET : BAD + "  not on PATH — backend skipped"}`);

	// browser
	const cdpUrl = process.env.PI_WEB_SEARCH_CDP_URL || "http://127.0.0.1:9222";
	const cdpHp = parseHostPort(cdpUrl);
	const cdpUp = cdpHp ? await probeTcp(cdpHp.host, cdpHp.port) : false;
	const harness = await which("browser-harness");
	const browserOk = cdpUp || !!harness;
	console.log(`  ${pad("browser", COL1)} ${browserOk ? OK : BAD}${browserOk ? "" : "  no CDP endpoint and no browser-harness — backend skipped"}`);
	console.log(`    ${pad("CDP", COL1-2)} ${cdpUp ? OK : WARN}  ${cdpUrl}${cdpUp ? "" : " (not reachable)"}`);
	console.log(`    ${pad("harness", COL1-2)} ${harness ? OK : WARN}  ${harness ?? "(not on PATH)"}`);

	if (!browserOk) {
		const { isArchLinux } = await import("../_common/playwright-utils.ts");
		if (isArchLinux()) {
			console.log(`    ${WARN} ${DIM}Suggestion: sudo pacman -S chromium${RESET}`);
		}
	}

	// ── Proxy ──
	section("Proxy");
	const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
	const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy ?? "";
	const wsProxy = process.env.PI_WEB_SEARCH_PROXY;

	if (wsProxy) console.log(`  ${pad("PI_WS_PROXY", COL1)} ${wsProxy}`);
	if (httpsProxy) console.log(`  ${pad("HTTPS_PROXY", COL1)} ${httpsProxy}`);
	if (httpProxy) console.log(`  ${pad("HTTP_PROXY", COL1)} ${httpProxy}`);

	if (!wsProxy && !httpsProxy && !httpProxy) {
		console.log(`  ${pad("Proxy", COL1)} ${DIM}(unset)${RESET}`);
	} else {
		const proxy = parseHostPort(wsProxy || httpsProxy || httpProxy || "http://127.0.0.1:7890");
		if (proxy) {
			const open = await probeTcp(proxy.host, proxy.port);
			console.log(`  ${pad(`tcp ${proxy.host}:${proxy.port}`, COL1)} ${open ? OK : BAD}${open ? "  open" : "  REFUSED — Clash/V2Ray dead?"}`);
		}
	}

	// ── Output ──
	section("Environment");
	console.log(`  ${pad("PI_WS_FORMAT", COL1)} ${process.env.PI_WS_FORMAT ?? DIM + "(unset)" + RESET}`);
	console.log(`  ${pad("PI_WS_CHAIN", COL1)} ${process.env.PI_WEB_SEARCH_CHAIN ?? DIM + "(unset)" + RESET}`);

	// ── Setup Guide ──
	section("New Device Setup");
	console.log(`  1. Ensure you have a browser installed (Chromium recommended).`);
	console.log(`  2. For Playwright/Defuddle: run ${BOLD}pi-wf --login https://www.google.com${RESET} once.`);
	console.log(`  3. If using Brave: set ${BOLD}BRAVE_SEARCH_API_KEY${RESET} in ~/.env (auto-loaded).`);
	console.log(`  4. If browser-harness fails: ensure Chrome is running with ${DIM}--remote-debugging-port=9222${RESET}`);

	console.log("");
}

// CLI entry — only runs when executed directly, not when imported.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	tryLoadEnv();
	await runDoctor();
}
