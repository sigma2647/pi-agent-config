#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
// pi-ws --doctor — environment & backend self-check.
//
// Mirrors `pi-wf --doctor` but for the web-search chain. Prints a one-glance
// report of: Node version, the effective chain + timeouts, each registered
// backend's availability (via its own isAvailable()) plus an actionable hint,
// and the relevant env vars. Designed to answer "why does backend X get
// skipped?" without digging through AGENTS.md.

import { loadConfig, listBackends, registerDefaultBackends } from "../chain.ts";
import { OK, BAD, WARN, which, probeTcp } from "./cli-helpers.ts";

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

export async function runDoctor(): Promise<void> {
	// Populate the REGISTRY so the Chain section reports the real backends even
	// when doctor.ts is run standalone (e.g. `node tools/doctor.ts`); via
	// `pi-ws --doctor` dev.ts has already registered them — idempotent either way.
	registerDefaultBackends();
	console.log("pi-ws doctor:\n");

	// Node
	console.log(`  Node              ${process.version} ${OK}`);

	// Chain config
	const cfg = loadConfig();
	console.log("\n  Chain:");
	console.log(`    registered      ${listBackends().join(", ") || "(none)"}`);
	console.log(`    effective       ${cfg.chain.join(" → ") || "(empty)"}`);
	console.log(`    totalTimeoutMs  ${cfg.totalTimeoutMs}`);
	console.log(`    perBackendMs    ${JSON.stringify(cfg.perBackendTimeoutMs)}`);

	// Backends — verdict comes from each backend's own isAvailable(); the hint
	// lines below add actionable detail the boolean can't carry.
	console.log("\n  Backends:");

	// brave
	const braveKey = process.env.BRAVE_SEARCH_API_KEY ?? "";
	console.log(`    brave           ${braveKey ? OK : BAD} ${braveKey ? mask(braveKey) : "(BRAVE_SEARCH_API_KEY unset — backend skipped)"}`);

	// opencli
	const opencli = await which("opencli");
	console.log(`    opencli         ${opencli ? OK : BAD} ${opencli ?? "(opencli not on PATH — backend skipped)"}`);

	// browser: CDP+playwright OR browser-harness
	const cdpUrl = process.env.PI_WEB_SEARCH_CDP_URL || "http://127.0.0.1:9222";
	// TCP probe, not fetch: CDP is loopback and with NODE_USE_ENV_PROXY=1 a
	// fetch would be sent through HTTP(S)_PROXY and fail even when Chrome is up.
	// A raw socket connect is immune to the proxy and only needs the port open.
	const cdpHp = parseHostPort(cdpUrl);
	const cdpUp = cdpHp ? await probeTcp(cdpHp.host, cdpHp.port) : false;
	const harness = await which("browser-harness");
	const browserOk = cdpUp || !!harness;
	console.log(`    browser         ${browserOk ? OK : BAD} ${browserOk ? "" : "(no CDP endpoint and no browser-harness — backend skipped)"}`);
	console.log(`      CDP           ${cdpUp ? OK : WARN} ${cdpUrl}${cdpUp ? "" : " (not reachable — launch Chrome with --remote-debugging-port=9222)"}`);
	console.log(`      harness       ${harness ? OK : WARN} ${harness ?? "(browser-harness not on PATH)"}`);

	// Proxy env + reachability (brave honors these)
	console.log("\n  Proxy env (brave backend):");
	const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
	const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy ?? "";
	const wsProxy = process.env.PI_WEB_SEARCH_PROXY;
	console.log(`    PI_WEB_SEARCH_PROXY     ${wsProxy === undefined ? "(unset)" : wsProxy === "" ? "(empty — proxy disabled)" : wsProxy}`);
	console.log(`    HTTPS_PROXY             ${httpsProxy || "(unset)"}`);
	console.log(`    HTTP_PROXY              ${httpProxy || "(unset)"}`);
	console.log(`    NODE_USE_ENV_PROXY      ${process.env.NODE_USE_ENV_PROXY ?? "(unset — Node fetch ignores HTTP_PROXY without this)"}`);
	const proxy = parseHostPort(wsProxy || httpsProxy || httpProxy || "http://127.0.0.1:7890");
	if (proxy) {
		const open = await probeTcp(proxy.host, proxy.port);
		console.log(`    tcp ${proxy.host}:${proxy.port}     ${open ? OK : WARN} ${open ? "open" : "REFUSED — Clash/V2Ray dead? bypass with PI_WEB_SEARCH_PROXY="}`);
	}

	// Output format
	console.log("\n  Output:");
	console.log(`    PI_WS_FORMAT            ${process.env.PI_WS_FORMAT ?? "(unset — defaults to json)"}`);
	console.log(`    PI_WEB_SEARCH_CHAIN     ${process.env.PI_WEB_SEARCH_CHAIN ?? "(unset — defaults to brave,opencli,browser)"}`);

	console.log("");
}

// CLI entry — only runs when executed directly, not when imported.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	await runDoctor();
}
