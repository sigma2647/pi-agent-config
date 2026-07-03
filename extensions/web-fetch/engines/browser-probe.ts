// browser-probe extraction engine for pi-wf.
//
// Uses the locally-installed browser-probe daemon for browser-based page
// extraction. The daemon keeps Chromium alive across calls — zero launch
// overhead vs Playwright cold start (~2s). Also reuses logged-in browser
// profiles created by `browser-probe browser login <url> -n <name>`.
//
// Placed between Jina Reader and Playwright in the fallback chain:
//   ... → Jina → browser-probe → Playwright → (exhausted)
// Rationale: Jina is external (free, no local resources), browser-probe
// is local + fast (daemon already running), Playwright is kept as final
// fallback (has CloakBrowser C++ stealth for the hardest anti-bot walls).
//
// Browser name selection:
//   - PI_WF_BROWSER_PROBE_BROWSER=name  → use specific browser
//   - (unset)                            → use first available browser
// Requires: browser-probe daemon running (auto-started by CLI if not)

import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import type { FetchContext, FetchResult } from "../core.ts";
import { MIN_USEFUL_CONTENT } from "../core.ts";
import { htmlToMarkdown } from "./readability.ts";

const execFile = promisify(_execFile);
const BP = "browser-probe";
const NAV_TIMEOUT_MS = 20000;
const EVAL_TIMEOUT_MS = 5000;

let cachedBrowser: string | null = null;

/** Run a browser-probe CLI command, return stdout trimmed. */
async function bp(args: string[]): Promise<string> {
	const { stdout } = await execFile(BP, args, {
		timeout: args[0] === "navigate" ? NAV_TIMEOUT_MS : EVAL_TIMEOUT_MS,
		env: { ...process.env },
	});
	return stdout.trim();
}

/** Pick a browser name: explicit env → cached auto-detected → default. */
async function pickBrowser(): Promise<string | null> {
	// Explicit override
	const explicit = process.env.PI_WF_BROWSER_PROBE_BROWSER?.trim();
	if (explicit) return explicit;

	// Use cached result from first detection
	if (cachedBrowser) return cachedBrowser;

	// Auto-detect: list browsers, pick first available
	try {
		const out = await bp(["browser", "list"]);
		const match = out.match(/^\s*(\S+)\s+\(/m);
		if (match) {
			cachedBrowser = match[1];
			return cachedBrowser;
		}
	} catch {
		// daemon not running or no browsers
	}
	return null;
}

/** Check if browser-probe is installed and daemon is reachable. */
async function isAvailable(): Promise<boolean> {
	try {
		await bp(["daemon", "status"]);
		return true;
	} catch {
		return false;
	}
}

export async function extractWithBrowserProbe(
	ctx: FetchContext,
): Promise<FetchResult | null> {
	// Skip if not configured or unavailable
	if (!(await isAvailable())) return null;

	const browser = await pickBrowser();
	if (!browser) return null;

	const bpOpts = ["-n", browser];

	// Navigate to the target URL
	try {
		await bp(["navigate", ctx.url, ...bpOpts]);
	} catch (err) {
		// Navigation timed out or failed — don't fall through to Playwright,
		// return null so the next engine gets a chance.
		return null;
	}

	if (ctx.signal?.aborted) return null;

	// Extract full page HTML
	let html: string;
	try {
		html = await bp([
			"eval",
			"document.documentElement.outerHTML",
			...bpOpts,
		]);
	} catch {
		return null;
	}

	if (!html || html.length < 200) return null;

	// Bail on anti-bot walls and login gates
	if (
		/安全验证|请您登录|please log\s*in|captcha required|Access Denied|Just a moment/i.test(
			html.slice(0, 3000),
		)
	) {
		return null;
	}

	// Parse + Readability
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
