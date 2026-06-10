// Shared Playwright resolver for pi-wf.
//
// Node's ESM resolver only walks up from the script's node_modules; it does
// not look at npm's global prefix or distro-managed paths (e.g. Arch's
// /usr/lib/node_modules). So we probe a handful of well-known locations
// before giving up, mirroring the logic in web-search/backends/browser.ts.

import { createRequire } from "node:module";
import { readFileSync, accessSync } from "node:fs";

type PWLike = { chromium: any };

const CANDIDATES = [
	"playwright",
	"playwright-core",
	"/usr/lib/node_modules/playwright",
	"/usr/lib/node_modules/playwright-core",
	"/usr/local/lib/node_modules/playwright",
	"/usr/local/lib/node_modules/playwright-core",
];

const REQUIRE_BASES = [
	"/usr/lib/node_modules/",
	"/usr/local/lib/node_modules/",
];

let cached: PWLike | null | undefined;

function pickModule(m: any): PWLike | null {
	// Playwright ships as CJS; dynamic ESM import wraps named exports both at
	// the top level and under `default`. Probe both.
	if (m?.chromium) return m as PWLike;
	if (m?.default?.chromium) return m.default as PWLike;
	return null;
}

export async function loadPlaywright(): Promise<PWLike | null> {
	if (cached !== undefined) return cached;
	for (const spec of CANDIDATES) {
		try {
			const picked = pickModule(await import(spec));
			if (picked) {
				cached = picked;
				return cached;
			}
		} catch {
			/* try next */
		}
	}
	for (const base of REQUIRE_BASES) {
		try {
			const req = createRequire(base);
			const resolved = req.resolve("playwright");
			const picked = pickModule(await import(resolved));
			if (picked) {
				cached = picked;
				return cached;
			}
		} catch {
			/* try next */
		}
	}
	cached = null;
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
	// Playwright CJS module doesn't expose .version when imported via ESM —
	// read package.json from well-known Arch path or the npm global prefix.
	for (const base of ["/usr/lib/node_modules/playwright", "/usr/lib/node_modules/playwright-core"]) {
		try {
			const pkg = JSON.parse(readFileSync(`${base}/package.json`, "utf8"));
			if (pkg.version) {
				cachedPwVersion = pkg.version;
				return cachedPwVersion;
			}
		} catch { /* try next */ }
	}
	cachedPwVersion = undefined;
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

export function playwrightInstallHint(): string {
	if (isArchLinux()) {
		return [
			"install on Arch:",
			"  sudo pacman -S playwright chromium",
			"system chromium auto-detected at /usr/bin/chromium",
		].join("\n");
	}
	return "install with: npm i -g playwright && npx playwright install chromium";
}
