// browser-probe extraction engine for pi-wf.
//
// Uses the locally-installed browser-probe daemon for browser-based page
// extraction. The daemon keeps Chromium alive across calls — zero launch
// overhead vs Playwright cold start (~2s). Also reuses logged-in browser
// state from the managed persistent browser seeded via `browser-probe open`.
//
// Placed between Jina Reader and Playwright in the fallback chain:
//   ... → Jina → browser-probe → Playwright → (exhausted)
// Rationale: Jina is external (free, no local resources), browser-probe
// is local + fast (daemon already running), Playwright is kept as final
// fallback (has CloakBrowser C++ stealth for the hardest anti-bot walls).
//
// browser-probe no longer exposes multi-browser/profile selection on the CLI;
// it always talks to one managed persistent browser. We therefore invoke the
// flat managed-browser commands directly (`navigate`, `eval`) and let the CLI
// auto-start its daemon/browser if needed.

import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import type { FetchContext, FetchResult } from "../core.ts";
import { MIN_USEFUL_CONTENT } from "../core.ts";
import { htmlToMarkdown } from "./readability.ts";
import { extractWithDefuddle } from "./defuddle.ts";
import { which } from "../../_common/tools/cli-helpers.ts";

const execFile = promisify(_execFile);
const BP = "browser-probe";
const NAV_TIMEOUT_MS = 20000;
// Full-page serialization of a 2 MB page plus the readiness poll below need more
// than the old 5 s budget.
const EVAL_TIMEOUT_MS = 20000;

/** Run a browser-probe CLI command, return stdout trimmed. */
async function bp(args: string[]): Promise<string> {
	const { stdout } = await execFile(BP, args, {
		timeout: args[0] === "navigate" ? NAV_TIMEOUT_MS : EVAL_TIMEOUT_MS,
		env: { ...process.env },
		// A full-page outerHTML comes back JSON-escaped, so a 400 KB page is a
		// >1 MB stdout string — past execFile's 1 MB default, which would throw
		// and make the engine decline every big page.
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout.trim();
}

/**
 * browser-probe prints eval results as JSON, so stdout is a quoted, escaped
 * JSON string. Hand it to Readability as-is and it parses the JSON wrapper
 * instead of the page.
 */
function unwrapEval(raw: string): string {
	try {
		const v: any = JSON.parse(raw);
		if (typeof v === "string") return v;
		if (typeof v?.value === "string") return v.value;
		if (typeof v?.result === "string") return v.result;
	} catch {
		// A quoted payload that won't parse means the CLI truncated it — returning
		// the fragment would feed Readability half a page of JSON escape noise.
		if (raw.startsWith('"')) return "";
	}
	return raw;
}

// `navigate` returns as soon as the navigation is committed, which for sites
// that redirect (Reddit: /comments/<id>/ → /comments/<id>/<slug>/) is a moment
// when documentElement is still null and readyState is "loading". Serializing
// then throws and the engine silently declines. Wait for a real document.
const WAIT_FOR_DOCUMENT = `await (async () => {
	for (let i = 0; i < 40; i++) {
		if (document.documentElement) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
})()`;

// Pages built from web components (Reddit's shreddit-*, many news sites) keep
// their real text in shadow roots, which documentElement.outerHTML does not
// serialize — Readability then only sees the page chrome. Copy each open
// shadow root into a light-DOM holder inside its host first.
const SERIALIZE_WITH_SHADOW = `(() => {
	const de = document.documentElement;
	if (!de) return "";
	const flatten = (root, depth) => {
		if (depth > 10) return;
		for (const el of root.querySelectorAll("*")) {
			const sr = el.shadowRoot;
			if (!sr) continue;
			try {
				const holder = document.createElement("div");
				holder.innerHTML = sr.innerHTML;
				el.appendChild(holder);
			} catch {}
			flatten(sr, depth + 1);
		}
	};
	flatten(document, 0);
	return de.outerHTML;
})()`;

/** Check if browser-probe is installed. The CLI auto-starts its daemon. */
async function isAvailable(): Promise<boolean> {
	return (await which(BP)) !== null;
}

export async function extractWithBrowserProbe(
	ctx: FetchContext,
): Promise<FetchResult | null> {
	// Skip if not configured or unavailable
	if (!(await isAvailable())) return null;

	// Navigate to the target URL
	try {
		await bp(["navigate", ctx.url]);
	} catch {
		// Navigation timed out or failed — don't fall through to Playwright,
		// return null so the next engine gets a chance.
		return null;
	}

	if (ctx.signal?.aborted) return null;

	// Navigation may still be redirecting — see WAIT_FOR_DOCUMENT.
	try {
		const ready = unwrapEval(await bp(["eval", WAIT_FOR_DOCUMENT]));
		if (ready !== "true") return null;
	} catch {
		return null;
	}

	if (ctx.signal?.aborted) return null;

	// Extract full page HTML (see SERIALIZE_WITH_SHADOW / unwrapEval above).
	let html: string;
	try {
		html = unwrapEval(await bp(["eval", SERIALIZE_WITH_SHADOW]));
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
	if (article) {
		const markdown = htmlToMarkdown(article.content, ctx.url);
		if (markdown.length >= MIN_USEFUL_CONTENT) {
			return {
				url: ctx.url,
				title: article.title || "",
				content: markdown,
				error: null,
			};
		}
	}

	// Readability under-reads JS-rendered and web-component pages — it only sees
	// the page chrome. Defuddle parses the same HTML with per-site extractors
	// (Reddit, GitHub, …) and schema.org metadata, so give it a second look
	// before declining. Cheap: no second fetch, the HTML is already in hand.
	const viaDefuddle = await extractWithDefuddle(ctx, html, MIN_USEFUL_CONTENT);
	if (viaDefuddle) return viaDefuddle;

	return null;
}
