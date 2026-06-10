#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
// pi-wf --doctor — environment & dependency self-check.
//
// Prints a structured report of: Node version, deps (playwright, defuddle,
// gh, jq), proxy env + reachability, Playwright profile + chromium path.
// Designed to answer "why doesn't fallback X kick in?" in one glance.

import { readdir } from "node:fs/promises";
import { statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, getPlaywrightExecutablePath, getPlaywrightVersion, isArchLinux } from "../playwright.ts";
import { OK, BAD, WARN, which, probeTcp, tryLoadEnv } from "../../_common/tools/cli-helpers.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function section(title: string): void {
	console.log(`\n${BOLD}  ▸ ${title}${RESET}`);
}

async function probeDefuddleLib(): Promise<{ ok: boolean; version: string } | null> {
	try {
		const m: any = await import("defuddle/node");
		if (typeof (m.Defuddle ?? m.default?.Defuddle) !== "function") return null;
		// defuddle/node doesn't expose .version — resolve module path and
		// read parent package.json (works regardless of cwd).
		let ver = "?";
		try {
			const modDir = dirname(dirname(fileURLToPath(import.meta.resolve("defuddle/node"))));
			ver = JSON.parse(readFileSync(join(modDir, "package.json"), "utf8")).version ?? "?";
		} catch { /* use "?" */ }
		return { ok: true, version: ver };
	} catch {
		return null;
	}
}

function parseProxy(url: string | undefined): { host: string; port: number } | null {
	if (!url) return null;
	try {
		const u = new URL(url);
		return { host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) };
	} catch {
		return null;
	}
}

function pad(label: string, width: number): string {
	const plain = label.replace(/\x1b\[[0-9;]*m/g, "");
	return label + " ".repeat(Math.max(1, width - plain.length));
}

const COL1 = 20;

export async function runDoctor(): Promise<void> {
	console.log(`${BOLD}══ pi-wf doctor ══${RESET}`);

	// ── Runtime ──
	section("Runtime");
	const nodeOk = process.version >= "v22.6.0";
	console.log(`  ${pad("Node.js", COL1)} ${process.version}  ${nodeOk ? OK : WARN}${nodeOk ? "" : "  (need ≥22.6 for --experimental-strip-types)"}`);

	// ── Dependencies ──
	section("Dependencies");

	const pw = await loadPlaywright();
	const pwVersion = getPlaywrightVersion();
	const chromiumPath = getPlaywrightExecutablePath();
	if (pw) {
		const pwLine = pwVersion ? `playwright  ${pwVersion}` : "playwright";
		const archTag = isArchLinux() ? ` ${DIM}(Arch system)${RESET}` : "";
		const crInfo = chromiumPath ? `  chromium → ${chromiumPath}` : "";
		console.log(`  ${pad(pwLine, COL1)} ${OK}${archTag}${crInfo}`);
	} else {
		const hint = isArchLinux() ? "sudo pacman -S playwright chromium" : "npm i -g playwright && npx playwright install chromium";
		console.log(`  ${pad("playwright", COL1)} ${BAD}  not found  —  ${hint}`);
	}

	const defuddle = await probeDefuddleLib();
	if (defuddle) {
		console.log(`  ${pad(`defuddle  ${defuddle.version}`, COL1)} ${OK}`);
	} else {
		console.log(`  ${pad("defuddle", COL1)} ${BAD}  not installed  —  cd extensions/web-fetch && npm install`);
	}

	const gh = await which("gh");
	console.log(`  ${pad("gh", COL1)} ${gh ? OK + "  " + gh : WARN + "  not found (optional — improves GitHub rate limits)"}`);

	const jq = await which("jq");
	console.log(`  ${pad("jq", COL1)} ${jq ? OK + "  " + jq : WARN + "  not found (needed only by install.sh)"}`);

	// ── Proxy ──
	const httpProxy = process.env.HTTP_PROXY ?? "";
	const httpsProxy = process.env.HTTPS_PROXY ?? "";

	if (httpProxy || httpsProxy) {
		section("Proxy");
		if (httpProxy) console.log(`  ${pad("HTTP_PROXY", COL1)} ${httpProxy}`);
		if (httpsProxy) console.log(`  ${pad("HTTPS_PROXY", COL1)} ${httpsProxy}`);
		const noProxy = process.env.NO_PROXY;
		if (noProxy) console.log(`  ${pad("NO_PROXY", COL1)} ${noProxy}`);

		const proxy = parseProxy(httpsProxy || httpProxy);
		if (proxy) {
			const open = await probeTcp(proxy.host, proxy.port);
			const statusLine = `tcp ${proxy.host}:${proxy.port}`;
			console.log(`  ${pad(statusLine, COL1)} ${open ? OK + "  open" : BAD + "  REFUSED — proxy dead? all fetches will fail"}`);
		}
	} else {
		console.log(`  ${pad("Proxy", COL1)} ${DIM}(unset)${RESET}`);
	}

	// ── Playwright ──
	section("Playwright");
	if (chromiumPath) {
		console.log(`  ${pad("Chromium", COL1)} ${OK}  ${chromiumPath}`);
	} else if (pw) {
		console.log(`  ${pad("Chromium", COL1)} ${WARN}  system chromium not found — needs npx playwright install chromium`);
	}

	const profileDir =
		process.env.PI_WF_PROFILE ?? `${process.env.HOME ?? ""}/.pw-capture-profile`;
	let profileExists = false;
	try {
		statSync(profileDir);
		profileExists = true;
	} catch { /* not a dir */ }
	if (profileExists) {
		let entries = 0;
		try { entries = (await readdir(profileDir)).length; } catch { /* unreadable */ }
		console.log(`  ${pad("Profile", COL1)} ${OK}  ${profileDir}  (${entries} entries)`);
	} else {
		console.log(`  ${pad("Profile", COL1)} ${WARN}  ${profileDir} — created on first --login`);
	}

	if (pw) {
		console.log(`  ${pad("Auto-hosts", COL1)} ${DIM}zhihu.com, weibo.com, xiaohongshu.com${RESET}`);
	}

	// ── Flags ──
	section("Debug flags");
	const debug = process.env.PI_WF_DEBUG;
	console.log(`  ${pad("PI_WF_DEBUG", COL1)} ${debug ? debug : DIM + "(unset — pass --debug to trace one call)" + RESET}`);
	const pwFlag = process.env.PI_WF_PLAYWRIGHT;
	console.log(`  ${pad("PI_WF_PLAYWRIGHT", COL1)} ${pwFlag ? pwFlag : DIM + "(unset)" + RESET}`);

	console.log("");
}

// CLI entry — only runs when executed directly, not when imported.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	tryLoadEnv();
	await runDoctor();
}
