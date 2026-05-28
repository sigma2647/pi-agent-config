import type { FetchResult } from "../core.ts";
import type { Extractor } from "./types.ts";
import { redditExtractor } from "./reddit.ts";
import { githubExtractor } from "./github.ts";
import { hackernewsExtractor } from "./hackernews.ts";

// Registry of domain-specific extractors. Order matters only for overlapping
// matchers (none currently overlap). To add a site: write an Extractor module
// and push it here — same pattern as web-search's `registerBackend`.
const EXTRACTORS: Extractor[] = [redditExtractor, githubExtractor, hackernewsExtractor];

export function registerExtractor(e: Extractor): void {
	EXTRACTORS.push(e);
}

/**
 * Try the first matching domain extractor. Returns its FetchResult on success,
 * or `null` to signal "no special handling — use the generic pipeline". A
 * matched extractor that returns null or throws is also treated as a decline.
 */
export async function dispatchExtractor(
	url: URL,
	signal?: AbortSignal,
): Promise<FetchResult | null> {
	for (const e of EXTRACTORS) {
		let matched = false;
		try {
			matched = e.match(url);
		} catch {
			matched = false;
		}
		if (!matched) continue;
		try {
			const result = await e.extract(url, signal);
			if (result && !result.error && result.content.trim().length > 0) {
				return result;
			}
		} catch {
			// fall through to the next extractor / generic pipeline
		}
	}
	return null;
}
