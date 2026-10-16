// pi-wf core — orchestrator + shared types. Extraction engines live in engines/,
// domain-specific extractors in extractors/.

import { EnvHttpProxyAgent, ProxyAgent } from "undici";
import { cookieFilePath } from "./cookies.ts";
import { dispatchExtractor } from "./extractors/index.ts";
import { extractWithDefuddle } from "./engines/defuddle.ts";
import { BOT_WALL_ERROR, extractHtml, fetchDocument } from "./engines/readability.ts";
import { extractWithJinaReader } from "./engines/jina.ts";
import { extractWithPlaywright, PLAYWRIGHT_AUTO_HOSTS } from "./engines/playwright.ts";
import { extractWithBrowserProbe } from "./engines/browser-probe.ts";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
// Single source of truth for the browser request fingerprint. fetchDocument
// (engines/readability.ts) is the only static fetch left — defuddle parses the
// HTML it returns — so any second static fetch added later must send these same
// headers. Inconsistent header shapes trip different CDN/anti-bot policies.
// Add headers here only.
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

// ── Anti-bot / login interstitials ────────────────────────────────────
// Marker text that appears only on an interstitial wall (Cloudflare, Fastly,
// captcha, login gate), never on the page the caller asked for. Walls arrive
// as HTTP 200 with real page chrome (title, canonical link) and are often long
// enough to pass MIN_USEFUL_CONTENT, so length alone cannot catch them. Single
// source of truth: readability, defuddle, jina and browser-probe all call
// looksLikeBotWall() instead of keeping their own marker list.
const BOT_WALL_PATTERN =
	/安全验证|请您登录|please log\s*in|captcha required|Access Denied|Just a moment|Client Challenge|A required part of this site|fastlyLogoError|_fs-ch-/i;

/** How much of the document to scan. Walls put their marker early; scanning
 *  a bounded prefix keeps a page that merely *quotes* a wall from matching. */
export const BOT_WALL_SCAN_CHARS = 4000;

/** True when `text` (raw HTML or extracted markdown) is a wall, not content. */
export function looksLikeBotWall(text: string): boolean {
	return BOT_WALL_PATTERN.test(text.slice(0, BOT_WALL_SCAN_CHARS));
}

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
	 * Pre-built undici dispatcher, bounded by CONNECT_TIMEOUT_MS. `undefined`
	 * means no proxy is configured, so undici defaults apply.
	 */
	dispatcher?: import("undici").Dispatcher;
	/**
	 * Path to the cookie jar the static fetch reads (`cookies.ts`). Resolved by
	 * makeContext from the caller / PI_WF_COOKIES / the default file. Absent or
	 * missing file = no cookies sent, which is the previous behaviour.
	 */
	cookiesPath?: string;
}

/** Build a `ProxyAgent` once for the given explicit proxy URL. */
/** Bound for every TCP connect pi-wf makes. undici's connector defaults to
 *  10s; through a local proxy that is usually a dead hop (observed:
 *  127.0.0.1:7890 accepting the connection then timing out upstream). pi-wf has
 *  a browser to try instead, so a wedged proxy costs ~3s per attempt, not 10s.
 *
 *  Must be passed as `proxyTls`/`requestTls.timeout`, NOT `connectTimeout`:
 *  ProxyAgent builds its proxy and origin connectors from those TLS option
 *  bags and ignores the top-level connectTimeout (measured: still 10.5s). */
const CONNECT_TIMEOUT_MS = 3000;
const CONNECT_TLS = { timeout: CONNECT_TIMEOUT_MS };

/** Build a dispatcher with a bounded connect timeout. An explicit proxy wins;
 *  otherwise follow the environment (HTTP_PROXY / HTTPS_PROXY / NO_PROXY) with
 *  the same semantics undici itself uses — EnvHttpProxyAgent is that class.
 *  Returns undefined only when no proxy is configured at all. */
function makeDispatcher(proxy?: string): import("undici").Dispatcher | undefined {
	try {
		if (proxy) {
			return new ProxyAgent({ uri: proxy, proxyTls: CONNECT_TLS, requestTls: CONNECT_TLS });
		}
		if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
			return new EnvHttpProxyAgent({ proxyTls: CONNECT_TLS, requestTls: CONNECT_TLS });
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Build a FetchContext with the dispatcher cached. Call once per fetchAndExtract. */
export function makeContext(
	url: string,
	signal?: AbortSignal,
	opts?: { proxy?: string; cookiesPath?: string },
): FetchContext {
	return {
		url,
		signal,
		proxy: opts?.proxy,
		dispatcher: makeDispatcher(opts?.proxy),
		cookiesPath: cookieFilePath(opts?.cookiesPath),
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
	/** Cookie jar: absent means read from the live browser; a path forces a
	 *  snapshot file (PI_WF_COOKIES / --cookies). */
	cookiesPath?: string;
}

type Step = [name: string, run: () => Promise<FetchResult | null>];

/**
 * Which fallbacks a static-path failure deserves. The failure says where the
 * blockage is, so it decides which engines can possibly get past it:
 *  - none:      content dead end (wrong type / too large) — we reached the
 *               origin and it served bytes nobody can use.
 *  - browser:   our egress failed (`fetch failed`). Jina's egress is blocked
 *               the same way, but a real browser — own TLS/H2 fingerprint,
 *               cookies, proxy handling — often loads it (Reddit).
 *  - skip-jina: anti-bot wall. Jina fetches from a datacenter IP, which meets
 *               walls more often than we do, not less (measured on pypi.org:
 *               Jina returned the same Fastly challenge after 3.2s, browser-probe
 *               passed in 0.65s). Go straight to the browser.
 *  - full:      everything else, incl. HTTP 5xx (often intermittent — Jina's
 *               separate egress + cache can still succeed) and JS shells.
 */
function fallbackRoute(error: string): "none" | "browser" | "skip-jina" | "full" {
	if (error.startsWith("Unsupported content type") || error.startsWith("Response too large")) {
		return "none";
	}
	if (error.startsWith("fetch failed")) return "browser";
	if (error === BOT_WALL_ERROR) return "skip-jina";
	return "full";
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

	if (signal?.aborted) return { url, title: "", content: "", error: "Aborted" };

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
	const ctx = makeContext(url, signal, { proxy: opts.proxy, cookiesPath: opts.cookiesPath });

	log(`url: ${url}`);
	log(`host: ${parsedUrl.hostname}  proxy: ${effectiveProxy(ctx) || "(none)"}`);
	log(`mode: ${preferDefuddle ? "defuddle-primary" : "readability-primary"}`);

	const aborted = (): FetchResult => ({ url, title: "", content: "", error: "Aborted" });

	/** Run engines in order; first non-null result wins. One place for the
	 *  abort check and the trace log instead of one copy per engine. */
	const runChain = async (steps: Step[]): Promise<FetchResult | "aborted" | null> => {
		for (const [name, run] of steps) {
			if (signal?.aborted) return "aborted";
			const r = await time(name, run);
			if (r) {
				log(`→ returning: ${name}`);
				return r;
			}
		}
		return signal?.aborted ? "aborted" : null;
	};

	// Domain-specific extractors first (reddit/github/HN/…). On decline they
	// return null and we fall through to the generic pipeline.
	const domain = await runChain([["domain-extractor", () => dispatchExtractor(ctx, parsedUrl)]]);
	if (domain === "aborted") return aborted();
	if (domain) return domain;

	// ONE HTTP fetch feeds both static extractors. Defuddle and Readability are
	// two readings of the same document, not two chances at the network: fetching
	// twice made a wedged proxy pay its connect timeout twice, and a normal page
	// pay for two downloads of the same bytes.
	const doc = await time("http fetch", () => fetchDocument(ctx));
	if (signal?.aborted) return aborted();

	let staticResult: FetchResult;
	if ("result" in doc) {
		// Non-HTML body or PDF: already extracted — or a fetch failure.
		staticResult = doc.result;
		if (!staticResult.error) {
			log("→ returning: http fetch");
			return staticResult;
		}
	} else {
		const html = doc.html;
		staticResult = { url, title: "", content: "", error: "No readable content" };
		// Defuddle (default primary) and Readability read the same HTML, each
		// once; --no-defuddle only flips the order. Readability's failure is kept
		// because its error text routes the fallbacks below.
		const defuddle: Step = ["defuddle", () => extractWithDefuddle(ctx, html)];
		const readability: Step = ["readability", async () => {
			staticResult = await extractHtml(ctx, html);
			return staticResult.error ? null : staticResult;
		}];
		const r = await runChain(preferDefuddle ? [defuddle, readability] : [readability, defuddle]);
		if (r === "aborted") return aborted();
		if (r) return r;
	}
	const error = staticResult.error ?? "";
	log(`static path failed: ${error.split("\n")[0]}`);

	const route = fallbackRoute(error);
	log(`fallback route: ${route}`);
	if (route === "none") return staticResult;

	const browserProbe: Step = ["browser-probe", () => extractWithBrowserProbe(ctx)];
	const playwright: Step = ["playwright", () => extractWithPlaywright(ctx)];
	const jina: Step = ["jina-reader", () => extractWithJinaReader(ctx)];
	const steps: Step[] =
		route === "browser" ? [browserProbe]
		: route === "skip-jina" ? [browserProbe, playwright]
		: [jina, browserProbe, playwright];
	const fallback = await runChain(steps);
	if (fallback === "aborted") return aborted();
	if (fallback) return fallback;
	log("→ all fallbacks exhausted");
	if (route === "browser") return staticResult;

	const hints = [
		"The page may be JavaScript-rendered or login-gated. Try:",
		"  • A different URL for the same content",
		"  • web_search to find cached/alternative versions",
	];
	const needsLogin = PLAYWRIGHT_AUTO_HOSTS.test(parsedUrl.hostname);
	const isAuthError = /HTTP (401|403|429)\b/.test(error);
	if (needsLogin) {
		hints.push(
			`  • This host blocks anonymous requests — seed cookies once:`,
			`      pi-wf --login ${parsedUrl.origin}`,
			`  • Cookies from the browser are reused automatically; check: browser-probe daemon status`,
		);
	} else if (isAuthError) {
		hints.push(
			`  • If the page requires sign-in, seed cookies once via:`,
			`      pi-wf --login ${parsedUrl.origin}`,
			`  • Cookies from the browser are reused automatically; check: browser-probe daemon status`,
		);
	}
	return { ...staticResult, error: `${error}\n\n${hints.join("\n")}` };
}
