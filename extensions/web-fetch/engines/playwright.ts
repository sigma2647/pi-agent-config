// Playwright + CloakBrowser browser-based extraction engine for pi-wf.
//
// Last-resort fallback for pages that block all anonymous server-side fetches
// (zhihu, weibo, xhs etc.). Launches headless Chromium with a persistent
// user-data-dir so cookies/login state survive across calls.
//
// Two paths to the same result: CloakBrowser (C++-level stealth, no JS
// injection) is preferred when installed. Playwright + STEALTH_SCRIPT is
// the fallback for environments without the cloakbrowser npm package.
//
// First-time setup for a new site: run tools/login_bootstrap.ts <url>,
// log in manually, close. After that pi-wf can reuse the cookies.
//
// Disabled by default unless PI_WF_PLAYWRIGHT=1 (Playwright is an optional
// peerDep and Chromium startup adds ~2s).

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import type { FetchContext, FetchResult } from "../core.ts";
import { BROWSER_HEADERS, MIN_USEFUL_CONTENT, effectiveProxy } from "../core.ts";
import { htmlToMarkdown } from "./readability.ts";
import { loadCloakBrowser } from "./cloakbrowser.ts";

// ── Playwright resolver (re-exported from _common) ─────────────────────
// Import first (creates local binding), then re-export.

import {
	loadPlaywright,
	isArchLinux,
	getPlaywrightVersion,
	getPlaywrightExecutablePath,
	decodeBingUrl,
} from "../../_common/playwright-utils.ts";

export {
	loadPlaywright,
	isArchLinux,
	getPlaywrightVersion,
	getPlaywrightExecutablePath,
	decodeBingUrl,
};

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

// ── Constants ───────────────────────────────────────────────────────────

const PLAYWRIGHT_TIMEOUT_MS = 30000;
const PLAYWRIGHT_SETTLE_MS = 1500;

const PLAYWRIGHT_PROFILE_DIR =
	process.env.PI_WF_PROFILE ??
	`${process.env.HOME ?? ""}/.pw-capture-profile`;

// CloakBrowser uses a separate profile dir — its Chromium binary is a
// different build from Playwright's, and profile formats are incompatible.
const CLOAKBROWSER_PROFILE_DIR =
	process.env.PI_WF_PROFILE ??
	`${process.env.HOME ?? ""}/.cb-capture-profile`;

// Minimal stealth init script — patches the headless tells that anti-bot
// scripts check first (navigator.webdriver, window.chrome, userAgentData,
// platform). Adapted from tiktok_clawler/config.py. Injected via
// `addInitScript` so it runs in every frame before page scripts. Heavier
// alternatives (puppeteer-extra-plugin-stealth.min.js, ~180 KB) exist but
// this 20-line version is enough for most CN sites.
const STEALTH_SCRIPT = `
  delete navigator.__proto__.webdriver;
  window.chrome = { runtime: {} };
  Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  if (!navigator.userAgentData) {
    Object.defineProperty(navigator, 'userAgentData', {
      value: {
        brands: [
          { brand: "Chromium", version: "122" },
          { brand: "Google Chrome", version: "122" },
          { brand: "Not:A-Brand", version: "24" }
        ],
        mobile: false,
        platform: "macOS",
        getHighEntropyValues: async () => ({
          architecture: "arm", model: "", platform: "macOS",
          platformVersion: "14.0.0", uaFullVersion: "122.0.0.0"
        })
      },
      writable: false, configurable: false
    });
  }
  // WebGL vendor/renderer spoof — many headless checks call this.
  const _getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (p) {
    if (p === 37445) return 'Intel Inc.';            // UNMASKED_VENDOR_WEBGL
    if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
    return _getParameter.call(this, p);
  };
  // Permissions API: report 'prompt' instead of 'denied' for notifications.
  const _query = navigator.permissions && navigator.permissions.query;
  if (_query) {
    navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : _query.call(navigator.permissions, p);
  }
`;

// Hosts that always block anonymous server-side fetches — we auto-enable the
// Playwright fallback for these without requiring PI_WF_PLAYWRIGHT=1. The user
// still has to do a one-time `pi-wf --login <url>` to seed cookies.
export const PLAYWRIGHT_AUTO_HOSTS = /(?:^|\.)(zhihu|weibo|xiaohongshu|bilibili|csdn|juejin)\.(?:com|cn|net)$/i;

function playwrightWantedFor(url: string): boolean {
	if (process.env.PI_WF_PLAYWRIGHT === "0") return false;
	if (process.env.PI_WF_PLAYWRIGHT === "1") return true;
	try {
		return PLAYWRIGHT_AUTO_HOSTS.test(new URL(url).hostname);
	} catch {
		return false;
	}
}

// One-time hint when CloakBrowser isn't installed but Playwright fallback is used.
let cloakbrowserHintShown = false;

// ── CloakBrowser extraction ─────────────────────────────────────────────

async function extractWithCloakBrowser(
	ctx: FetchContext,
	cb: Awaited<ReturnType<typeof loadCloakBrowser>>,
): Promise<FetchResult | null> {
	const proxy = effectiveProxy(ctx);

	const browserCtx = await cb!.launchPersistentContext({
		userDataDir: CLOAKBROWSER_PROFILE_DIR,
		headless: true,
		proxy: proxy || undefined,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
	});

	let html: string | null = null;
	try {
		const page = await browserCtx.newPage();
		const onAbort = () => page.close().catch(() => {});
		ctx.signal?.addEventListener("abort", onAbort);
		try {
			await page
				.goto(ctx.url, { waitUntil: "domcontentloaded", timeout: PLAYWRIGHT_TIMEOUT_MS })
				.catch(() => {}); // some SPAs never fire DOMContentLoaded — keep going
			await page.waitForTimeout(PLAYWRIGHT_SETTLE_MS);
			html = await page.content();
		} finally {
			ctx.signal?.removeEventListener("abort", onAbort);
		}
	} catch {
		html = null;
	} finally {
		await browserCtx.close().catch(() => {});
	}

	if (!html) return null;

	if (/安全验证|请您登录|please log\s*in|captcha required/i.test(html.slice(0, 2000))) {
		return null;
	}

	const { document } = parseHTML(html);
	const reader = new Readability(document as unknown as Document);
	const article = reader.parse();
	if (!article) return null;

	const markdown = htmlToMarkdown(article.content, ctx.url);
	if (markdown.length < MIN_USEFUL_CONTENT) return null;
	return {
		url: ctx.url,
		title: article.title || "",
		content: markdown,
		error: null,
	};
}

// ── Playwright extraction (with CloakBrowser preference) ────────────────

export async function extractWithPlaywright(
	ctx: FetchContext,
): Promise<FetchResult | null> {
	if (!playwrightWantedFor(ctx.url)) return null;

	// Prefer CloakBrowser — C++-level stealth, no JS injection needed.
	const cb = await loadCloakBrowser();
	if (cb) return extractWithCloakBrowser(ctx, cb);

	// Fall back to Playwright Chromium + JS stealth script.
	// One-time hint: CloakBrowser gives 26/31 anti-bot bypass vs 24/31 baseline.
	if (!cloakbrowserHintShown) {
		cloakbrowserHintShown = true;
		console.error("[pi-wf] CloakBrowser not installed — falling back to Playwright (JS stealth).");
		console.error("[pi-wf]   For C++-level stealth: npm install cloakbrowser playwright-core");
	}
	const pw = await loadPlaywright();
	if (!pw) return null;

	const proxy = effectiveProxy(ctx);

	const browser = await pw.chromium.launchPersistentContext(PLAYWRIGHT_PROFILE_DIR, {
		headless: true,
		executablePath: getPlaywrightExecutablePath() ?? undefined,
		userAgent: BROWSER_HEADERS["User-Agent"],
		viewport: { width: 1280, height: 800 },
		locale: "zh-CN",
		proxy: proxy ? { server: proxy } : undefined,
		args: [
			"--disable-blink-features=AutomationControlled",
			"--disable-dev-shm-usage",
			"--no-sandbox",
		],
	});
	await browser.addInitScript(STEALTH_SCRIPT);

	let html: string | null = null;
	try {
		const page = await browser.newPage();
		const onAbort = () => page.close().catch(() => {});
		ctx.signal?.addEventListener("abort", onAbort);
		try {
			await page
				.goto(ctx.url, { waitUntil: "domcontentloaded", timeout: PLAYWRIGHT_TIMEOUT_MS })
				.catch(() => {}); // some SPAs never fire DOMContentLoaded — keep going
			await page.waitForTimeout(PLAYWRIGHT_SETTLE_MS);
			html = await page.content();
		} finally {
			ctx.signal?.removeEventListener("abort", onAbort);
		}
	} catch {
		html = null;
	} finally {
		await browser.close().catch(() => {});
	}

	if (!html) return null;

	// Bail early if it's the obvious anti-bot wall — don't return "安全验证"
	// as the title.
	if (/安全验证|请您登录|please log\s*in|captcha required/i.test(html.slice(0, 2000))) {
		return null;
	}

	const { document } = parseHTML(html);
	const reader = new Readability(document as unknown as Document);
	const article = reader.parse();
	if (!article) return null;

	const markdown = htmlToMarkdown(article.content, ctx.url);
	if (markdown.length < MIN_USEFUL_CONTENT) return null;
	return {
		url: ctx.url,
		title: article.title || "",
		content: markdown,
		error: null,
	};
}
