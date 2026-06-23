// pi-wf core — orchestrator + shared types. Extraction engines live in engines/,
// domain-specific extractors in extractors/.

import { ProxyAgent } from "undici";
import { dispatchExtractor } from "./extractors/index.ts";
import { extractWithDefuddle } from "./engines/defuddle.ts";
import { extractViaHttp } from "./engines/readability.ts";
import { extractWithJinaReader } from "./engines/jina.ts";
import { extractWithPlaywright, PLAYWRIGHT_AUTO_HOSTS } from "./engines/playwright.ts";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
// Single source of truth for the browser request fingerprint. extractViaHttp
// (engines/readability.ts) and extractWithDefuddle (engines/defuddle.ts) MUST
// send identical headers — inconsistent header shapes trip different CDN/anti-bot
// policies. Add headers here only.
export const BROWSER_HEADERS = {
	"User-Agent": USER_AGENT,
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Cache-Control": "no-cache",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
} as const;
export const MIN_USEFUL_CONTENT = 500;

/** Threshold above which single-URL fetches are truncated and stored for
 *  later retrieval. Matches pi-web-access's 30 KB — large enough that most
 *  docs/blog-posts fit inline, small enough to avoid context-window bloat. */
export const TRUNCATION_THRESHOLD = 30_000;

// ── Fetch execution context ───────────────────────────────────────────
// Every extraction engine, every domain extractor takes a FetchContext
// instead of `(url, signal, proxy?, ...)`. Adding a new per-request option
// (timeout, userAgent, custom headers, ...) is a one-line change to this
// interface plus the makeContext builder; no signatures downstream move.
// The dispatcher is built once when the ctx is created and reused across
// the whole fallback chain.

export interface FetchContext {
	/** The page URL being fetched. */
	url: string;
	/** Caller-supplied cancellation signal. */
	signal?: AbortSignal;
	/** Explicit proxy URL (overrides env). Falls back to env when absent. */
	proxy?: string;
	/**
	 * Pre-built undici dispatcher. `undefined` means "use undici default"
	 * which respects EnvHttpProxyAgent (i.e. `HTTP_PROXY` / `HTTPS_PROXY`).
	 */
	dispatcher?: import("undici").Dispatcher;
}

/** Build a `ProxyAgent` once for the given explicit proxy URL. */
function makeDispatcher(proxy?: string): import("undici").Dispatcher | undefined {
	if (!proxy) return undefined;
	try {
		return new ProxyAgent(proxy);
	} catch {
		return undefined;
	}
}

/** Build a FetchContext with the dispatcher cached. Call once per fetchAndExtract. */
export function makeContext(
	url: string,
	signal?: AbortSignal,
	opts?: { proxy?: string },
): FetchContext {
	return {
		url,
		signal,
		proxy: opts?.proxy,
		dispatcher: makeDispatcher(opts?.proxy),
	};
}

/** Resolved proxy URL for display / error messages / Chromium config. */
export function effectiveProxy(ctx: FetchContext): string {
	return ctx.proxy ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? "";
}

export interface FetchResult {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

// ── Public Fetch Function ────────────────────────────────────────────

export interface FetchOptions {
	debug?: boolean;
	preferDefuddle?: boolean;
	proxy?: string;
}

export async function fetchAndExtract(
	url: string,
	signal?: AbortSignal,
	opts: FetchOptions = {},
): Promise<FetchResult> {
	const debug = opts.debug || process.env.PI_WF_DEBUG === "1";
	// Defuddle-by-default: cleaner Pandoc footnotes, schema.org metadata,
	// more complete section structure → friendlier for both humans and LLMs.
	// ~260ms slower than Readability but worth it. Disable per-call by setting
	// `opts.preferDefuddle: false`, globally by `PI_WF_PREFER_DEFUDDLE=0`.
	const preferDefuddle =
		opts.preferDefuddle ?? process.env.PI_WF_PREFER_DEFUDDLE !== "0";
	const log = (msg: string) => {
		if (debug) process.stderr.write(`[pi-wf] ${msg}\n`);
	};
	const time = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		const t0 = performance.now();
		try {
			const r = await fn();
			log(`${name}: done in ${(performance.now() - t0).toFixed(0)}ms`);
			return r;
		} catch (e) {
			log(`${name}: threw after ${(performance.now() - t0).toFixed(0)}ms — ${(e as Error)?.message ?? e}`);
			throw e;
		}
	};

	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}

	// Build the per-request context once. Every extractor / fetch helper /
	// diagnostic function downstream takes this same ctx — adding a new
	// per-call option (timeout, userAgent, ...) is a one-line edit to
	// FetchContext + a line in makeContext, no signature changes downstream.
	const ctx = makeContext(url, signal, { proxy: opts.proxy });

	log(`url: ${url}`);
	log(`host: ${parsedUrl.hostname}  proxy: ${effectiveProxy(ctx) || "(none)"}`);
	log(`mode: ${preferDefuddle ? "defuddle-primary" : "readability-primary"}`);

	// Domain-specific extractors first (reddit/github/HN/…). On decline they
	// return null and we fall through to the generic Readability/Jina pipeline.
	const domainResult = await time("domain-extractor", () =>
		dispatchExtractor(ctx, parsedUrl),
	);
	if (domainResult) {
		log("→ returning: domain-extractor");
		return domainResult;
	}
	if (signal?.aborted) return { url, title: "", content: "", error: "Aborted" };

	// Defuddle-primary path: try defuddle FIRST (cleaner Pandoc footnotes,
	// schema.org metadata, more complete section structure). Falls through to
	// Readability if defuddle isn't installed / errors / returns too little.
	if (preferDefuddle) {
		const r = await time("defuddle (primary)", () => extractWithDefuddle(ctx));
		if (r) {
			log("→ returning: defuddle (primary)");
			return r;
		}
		if (signal?.aborted) return { url, title: "", content: "", error: "Aborted" };
		log("defuddle returned null — falling through to Readability");
	}

	const httpResult = await time("http+Readability", () => extractViaHttp(ctx));
	if (signal?.aborted)
		return { url, title: "", content: "", error: "Aborted" };
	if (!httpResult.error) {
		log("→ returning: http+Readability");
		return httpResult;
	}
	log(`http+Readability failed: ${httpResult.error.split("\n")[0]}`);

	if (
		httpResult.error.startsWith("Unsupported content type") ||
		httpResult.error.startsWith("Response too large") ||
		httpResult.error.startsWith("fetch failed")
	) {
		// Network/content-level dead ends — we never reached the origin
		// (fetch failed) or the response is unusable by definition. Extra
		// fallbacks (defuddle, Jina, playwright) hit the same wall. Return the
		// diagnostic error without the misleading "JS-rendered/login-gated"
		// suffix. NOTE: HTTP 5xx is deliberately NOT here — a 5xx means we DID
		// reach the CDN/origin and it errored, often intermittently; Jina
		// Reader fetches via a separate egress + cache and can still succeed,
		// so 5xx falls through to the remaining chain.
		log("→ returning: http error (network/content — no fallback)");
		return httpResult;
	}

	// Skip the middle-chain defuddle if defuddle-primary already ran it once
	// and it returned null. Would waste ~300ms re-doing the same work.
	if (!preferDefuddle) {
		const defuddleResult = await time("defuddle", () => extractWithDefuddle(ctx));
		if (defuddleResult) {
			log("→ returning: defuddle");
			return defuddleResult;
		}
		if (signal?.aborted)
			return { url, title: "", content: "", error: "Aborted" };
	} else {
		log("defuddle (middle): skipped (already tried as forced)");
	}

	const jinaResult = await time("jina-reader", () => extractWithJinaReader(ctx));
	if (jinaResult) {
		log("→ returning: jina-reader");
		return jinaResult;
	}
	if (signal?.aborted)
		return { url, title: "", content: "", error: "Aborted" };

	const playwrightResult = await time("playwright", () => extractWithPlaywright(ctx));
	if (playwrightResult) {
		log("→ returning: playwright");
		return playwrightResult;
	}
	if (signal?.aborted)
		return { url, title: "", content: "", error: "Aborted" };
	log("→ all fallbacks exhausted");

	const hints = [
		"The page may be JavaScript-rendered or login-gated. Try:",
		"  • A different URL for the same content",
		"  • web_search to find cached/alternative versions",
	];
	const needsLogin = PLAYWRIGHT_AUTO_HOSTS.test(parsedUrl.hostname);
	const isAuthError = /HTTP (401|403|429)\b/.test(httpResult.error);
	if (needsLogin) {
		hints.push(
			`  • This host blocks anonymous requests — seed cookies once:`,
			`      pi-wf --login ${parsedUrl.origin}`,
		);
	} else if (isAuthError) {
		hints.push(
			`  • If the page requires sign-in, seed cookies once via:`,
			`      pi-wf --login ${parsedUrl.origin}`,
		);
	}
	return {
		...httpResult,
		error: `${httpResult.error}\n\n${hints.join("\n")}`,
	};
}
