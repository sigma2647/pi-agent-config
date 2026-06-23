#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
// Interactive login bootstrap for the pi-wf Playwright fallback.
//
// Opens a headed Chromium with the persistent profile at ~/.pw-capture-profile,
// navigates to the target URL, and waits for you to log in. Press Enter once
// done — cookies persist in the profile dir and subsequent pi-wf calls with
// PI_WF_PLAYWRIGHT=1 (or `pi-wf --playwright`) reuse them.
//
// Prefers CloakBrowser (C++-level stealth) when installed; falls back to
// Playwright Chromium + JS stealth script.
//
// Usage:
//   pi-wf --login <url>              # via pi-wf entry point
//   ./tools/login_bootstrap.ts <url> # direct

import readline from "node:readline";
import { loadCloakBrowser } from "../engines/cloakbrowser.ts";
import { loadPlaywright, getPlaywrightExecutablePath, playwrightInstallHint } from "../engines/playwright.ts";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export async function runLoginBootstrap(url: string): Promise<void> {
	const profileDir =
		process.env.PI_WF_PROFILE ??
		`${process.env.HOME ?? ""}/.pw-capture-profile`;

	console.error(`profile: ${profileDir}`);

	// Prefer CloakBrowser — C++-level stealth, no JS injection needed.
	const cb = await loadCloakBrowser();
	if (cb) {
		console.error("using CloakBrowser (stealth Chromium)");
		console.error(`opening ${url} in a Chrome window…`);

		const ctx = await cb.launchPersistentContext({
			userDataDir: profileDir,
			headless: false,
			args: ["--no-sandbox", "--disable-dev-shm-usage"],
		});

		const page = ctx.pages()[0] ?? (await ctx.newPage());
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

		console.error("\n  ↳ log in in the browser window that just opened.");
		console.error("  ↳ when done, press Enter here to save cookies and exit.\n");

		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		await new Promise<void>((resolve) =>
			rl.question("press Enter when done: ", () => resolve()),
		);
		rl.close();

		await ctx.close();
		console.error("cookies saved. now try:");
		console.error(`  pi-wf --playwright ${url}`);
		return;
	}

	// Fall back to Playwright Chromium + JS stealth script.
	const pw = await loadPlaywright();
	if (!pw) {
		console.error("error: playwright is not installed.");
		console.error(playwrightInstallHint());
		process.exit(1);
	}
	const { chromium } = pw;

	console.error(`opening ${url} in a Chrome window…`);

	const ctx = await chromium.launchPersistentContext(profileDir, {
		executablePath: getPlaywrightExecutablePath() ?? undefined,
		headless: false,
		userAgent: UA,
		viewport: { width: 1280, height: 800 },
		locale: "zh-CN",
		args: ["--disable-blink-features=AutomationControlled"],
	});

	// Same stealth script as the headless fetch path — keeps the env consistent
	// so any device fingerprint stored during login still matches at fetch time.
	const STEALTH_SCRIPT = `
		delete navigator.__proto__.webdriver;
		window.chrome = { runtime: {} };
		Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
		Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
	`;
	await ctx.addInitScript(STEALTH_SCRIPT);

	const page = ctx.pages()[0] ?? (await ctx.newPage());
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

	console.error("\n  ↳ log in in the browser window that just opened.");
	console.error("  ↳ when done, press Enter here to save cookies and exit.\n");

	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	await new Promise<void>((resolve) =>
		rl.question("press Enter when done: ", () => resolve()),
	);
	rl.close();

	await ctx.close();
	console.error("cookies saved. now try:");
	console.error(`  pi-wf --playwright ${url}`);
}

// CLI entry — only runs when executed directly, not when imported.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	const url = process.argv[2];
	if (!url) {
		console.error("usage: login_bootstrap.ts <url>");
		process.exit(1);
	}
	await runLoginBootstrap(url);
}
