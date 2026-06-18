// Shared Playwright and system utilities for pi extensions.
import { createRequire } from "node:module";
import { readFileSync, accessSync } from "node:fs";

import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileP = promisify(execFile);

export type PWLike = { chromium: any };

const STATIC_CANDIDATES = [
	"playwright",
	"playwright-core",
	"/usr/lib/node_modules/playwright",
	"/usr/lib/node_modules/playwright-core",
	"/usr/local/lib/node_modules/playwright",
	"/usr/local/lib/node_modules/playwright-core",
];

export async function getGlobalNpmRoot(): Promise<string | null> {
	try {
		const { stdout } = await execFileP("npm", ["root", "-g"], { timeout: 2000 });
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

let cachedPW: PWLike | null | undefined;

function pickModule(m: any): PWLike | null {
	if (m?.chromium) return m as PWLike;
	if (m?.default?.chromium) return m.default as PWLike;
	return null;
}

export async function loadPlaywright(): Promise<PWLike | null> {
	if (cachedPW !== undefined) return cachedPW;

	// 1. Try static candidates and normal resolution
	for (const spec of STATIC_CANDIDATES) {
		try {
			const picked = pickModule(await import(spec));
			if (picked) {
				cachedPW = picked;
				return cachedPW;
			}
		} catch { /* next */ }
	}

	// 2. Try dynamic global npm root
	const globalRoot = await getGlobalNpmRoot();
	if (globalRoot) {
		for (const name of ["playwright", "playwright-core"]) {
			try {
				const req = createRequire(globalRoot + "/");
				const resolved = req.resolve(name);
				const picked = pickModule(await import(resolved));
				if (picked) {
					cachedPW = picked;
					return cachedPW;
				}
			} catch { /* next */ }
		}
	}

	// 3. Fallback to common require bases
	const REQUIRE_BASES = [
		"/usr/lib/node_modules/",
		"/usr/local/lib/node_modules/",
	];
	for (const base of REQUIRE_BASES) {
		try {
			const req = createRequire(base);
			const resolved = req.resolve("playwright");
			const picked = pickModule(await import(resolved));
			if (picked) {
				cachedPW = picked;
				return cachedPW;
			}
		} catch { /* try next */ }
	}
	cachedPW = null;
	return null;
}

let cachedIsArch: boolean | undefined;

export function isArchLinux(): boolean {
	if (cachedIsArch !== undefined) return cachedIsArch;
	try {
		const os = readFileSync("/etc/os-release", "utf8");
		cachedIsArch = /^ID(_LIKE)?=.*\barch\b/m.test(os);
	} catch {
		cachedIsArch = false;
	}
	return cachedIsArch;
}

const SYSTEM_CHROMIUM = "/usr/bin/chromium";

let cachedPwVersion: string | undefined;

export function getPlaywrightVersion(): string | undefined {
	if (cachedPwVersion !== undefined) return cachedPwVersion;
	for (const base of ["/usr/lib/node_modules/playwright", "/usr/lib/node_modules/playwright-core"]) {
		try {
			const pkg = JSON.parse(readFileSync(`${base}/package.json`, "utf8"));
			if (pkg.version) {
				cachedPwVersion = pkg.version;
				return cachedPwVersion;
			}
		} catch { /* try next */ }
	}
	return undefined;
}

export function getPlaywrightExecutablePath(): string | undefined {
	if (!isArchLinux()) return undefined;
	try {
		accessSync(SYSTEM_CHROMIUM);
		return SYSTEM_CHROMIUM;
	} catch {
		return undefined;
	}
}

/**
 * Common Bing URL decoder to recover real destination from click-tracking links.
 * Bing wraps hrefs in /ck/a?u=a1<urlsafe-b64>.
 */
export function decodeBingUrl(href: string): string {
	try {
		const u = new URL(href);
		const enc = u.searchParams.get("u");
		if (enc && enc.startsWith("a1")) {
			const raw = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
			return atob(raw + "===".slice((raw.length + 3) % 4));
		}
	} catch { /* return original */ }
	return href;
}
