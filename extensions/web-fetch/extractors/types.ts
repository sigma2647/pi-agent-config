import type { FetchContext, FetchResult } from "../core.ts";

/**
 * A domain-specific extractor. Mirrors the backend-registry pattern used by
 * the web-search extension: register a set of matchers, dispatch on URL, and
 * fall back to the generic Readability/Jina pipeline when none match (or when
 * the matched one returns null).
 *
 * `extract` receives the same `FetchContext` used by the generic pipeline —
 * the dispatcher inside ctx routes API calls through `--proxy` and tool
 * params automatically. The matched URL is also passed separately as
 * `parsedUrl` since extractors usually act on the page URL while fetching
 * other endpoints derived from it.
 */
export interface Extractor {
	/** Stable name for logging/diagnostics. */
	name: string;
	/** Return true if this extractor wants to handle the given URL. */
	match: (url: URL) => boolean;
	/**
	 * Extract content. Return a FetchResult on success, or `null` to decline
	 * (the dispatcher then falls through to the generic pipeline). Throwing is
	 * also treated as "decline" — the generic pipeline still runs.
	 */
	extract: (ctx: FetchContext, parsedUrl: URL) => Promise<FetchResult | null>;
}

export const FETCH_TIMEOUT_MS = 30000;

export const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * Shared JSON GET helper with timeout + abort propagation. `url` defaults to
 * the context URL; extractors usually override it with API endpoints they
 * derive from the page URL.
 */
export async function fetchJson<T = unknown>(
	ctx: FetchContext,
	url: string = ctx.url,
): Promise<T | null> {
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
			dispatcher: ctx.dispatcher,
			signal: AbortSignal.any([
				AbortSignal.timeout(FETCH_TIMEOUT_MS),
				...(ctx.signal ? [ctx.signal] : []),
			]),
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

/** Shared text GET helper with timeout + abort propagation. */
export async function fetchText(
	ctx: FetchContext,
	url: string = ctx.url,
): Promise<string | null> {
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": USER_AGENT },
			dispatcher: ctx.dispatcher,
			signal: AbortSignal.any([
				AbortSignal.timeout(FETCH_TIMEOUT_MS),
				...(ctx.signal ? [ctx.signal] : []),
			]),
		});
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	}
}
