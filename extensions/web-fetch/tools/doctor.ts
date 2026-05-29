#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
// pi-wf --doctor — environment & dependency self-check.
//
// Prints a one-glance report of: Node version, optional CLI deps (playwright,
// defuddle, gh, jq), proxy env state, profile dir, and a TCP probe of the
// proxy port. Designed to answer "why doesn't fallback X kick in?" without
// the user having to dig through CLAUDE.md.

import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { connect } from "node:net";
import { loadPlaywright } from "../playwright.ts";

const execFileP = promisify(execFile);

const OK = "\x1b[32m✓\x1b[0m";
const BAD = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m!\x1b[0m";

async function which(cmd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileP("which", [cmd]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

async function probeDefuddleLib(): Promise<boolean> {
	try {
		const m: any = await import("defuddle/node");
		return typeof (m.Defuddle ?? m.default?.Defuddle) === "function";
	} catch {
		return false;
	}
}

async function probeTcp(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connect({ host, port });
		const t = setTimeout(() => {
			sock.destroy();
			resolve(false);
		}, timeoutMs);
		sock.once("connect", () => {
			clearTimeout(t);
			sock.end();
			resolve(true);
		});
		sock.once("error", () => {
			clearTimeout(t);
			resolve(false);
		});
	});
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

export async function runDoctor(): Promise<void> {
	console.log("pi-wf doctor:\n");

	// Node
	console.log(`  Node              ${process.version} ${OK}`);

	// Optional deps
	console.log("\n  Optional deps:");
	const pw = await loadPlaywright();
	console.log(`    playwright      ${pw ? OK : BAD} ${pw ? "(resolved)" : "(not found — install: sudo pacman -S playwright  OR  npm i -g playwright)"}`);
	const defuddleLib = await probeDefuddleLib();
	console.log(`    defuddle lib    ${defuddleLib ? OK : WARN} ${defuddleLib ? "(import 'defuddle/node' OK)" : "(not installed — run: cd extensions/web-fetch && npm install)"}`);
	const gh = await which("gh");
	console.log(`    gh              ${gh ? OK : WARN} ${gh ?? "(not found — optional, improves GitHub rate limits)"}`);
	const jq = await which("jq");
	console.log(`    jq              ${jq ? OK : WARN} ${jq ?? "(not found — needed only by install.sh)"}`);

	// Proxy env
	console.log("\n  Proxy env:");
	const httpProxy = process.env.HTTP_PROXY ?? "";
	const httpsProxy = process.env.HTTPS_PROXY ?? "";
	const noProxy = process.env.NO_PROXY ?? "";
	const useEnv = process.env.NODE_USE_ENV_PROXY ?? "";
	console.log(`    HTTP_PROXY              ${httpProxy || "(unset)"}`);
	console.log(`    HTTPS_PROXY             ${httpsProxy || "(unset)"}`);
	console.log(`    NO_PROXY                ${noProxy || "(unset)"}`);
	console.log(`    NODE_USE_ENV_PROXY      ${useEnv || "(unset — Node fetch ignores HTTP_PROXY without this)"}`);

	// Proxy reachability
	const proxy = parseProxy(httpsProxy || httpProxy);
	if (proxy) {
		console.log("\n  Proxy reachability:");
		const open = await probeTcp(proxy.host, proxy.port);
		console.log(`    tcp ${proxy.host}:${proxy.port}     ${open ? OK : BAD} ${open ? "open" : "REFUSED — Clash/V2Ray dead? all fetches will fail"}`);
	}

	// Profile dir
	console.log("\n  Profile (Playwright --login):");
	const profileDir =
		process.env.PI_WF_PROFILE ?? `${process.env.HOME ?? ""}/.pw-capture-profile`;
	console.log(`    PI_WF_PROFILE           ${process.env.PI_WF_PROFILE ?? "(unset, using default)"}`);
	let exists = false;
	try {
		statSync(profileDir);
		exists = true;
	} catch {
		/* not a dir */
	}
	if (exists) {
		let entries = 0;
		try {
			entries = (await readdir(profileDir)).length;
		} catch {
			/* unreadable */
		}
		console.log(`    path                    ${profileDir} ${OK} (${entries} entries)`);
	} else {
		console.log(`    path                    ${profileDir} ${WARN} (does not exist — created on first --login)`);
	}

	// Auto-playwright hosts
	console.log("\n  Auto-Playwright hosts (need --login once):");
	console.log("    zhihu.com, weibo.com, xiaohongshu.com");

	// Debug
	console.log("\n  Debug:");
	console.log(`    PI_WF_DEBUG             ${process.env.PI_WF_DEBUG ?? "(unset — pass --debug to trace one call)"}`);
	console.log(`    PI_WF_PLAYWRIGHT        ${process.env.PI_WF_PLAYWRIGHT ?? "(unset)"}`);

	console.log("");
}

// CLI entry — only runs when executed directly, not when imported.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	await runDoctor();
}
