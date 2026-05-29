// Shared Playwright resolver for pi-wf.
//
// Node's ESM resolver only walks up from the script's node_modules; it does
// not look at npm's global prefix or distro-managed paths (e.g. Arch's
// /usr/lib/node_modules). So we probe a handful of well-known locations
// before giving up, mirroring the logic in web-search/backends/browser.ts.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

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

function isArchLinux(): boolean {
	if (cachedIsArch !== undefined) return cachedIsArch;
	try {
		const os = readFileSync("/etc/os-release", "utf8");
		cachedIsArch = /^ID(_LIKE)?=.*\barch\b/m.test(os);
	} catch {
		cachedIsArch = false;
	}
	return cachedIsArch;
}

export function playwrightInstallHint(): string {
	if (isArchLinux()) {
		return [
			"install on Arch:",
			"  sudo pacman -S playwright    # or: paru -S playwright",
			"system chromium/firefox executables are wired via /etc/profile.d/playwright.sh",
		].join("\n");
	}
	return "install with: npm i -g playwright && npx playwright install chromium";
}
