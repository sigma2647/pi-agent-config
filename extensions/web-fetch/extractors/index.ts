import type { FetchResult } from "../core.ts";
import type { Extractor } from "./types.ts";
import { bilibiliExtractor } from "./bilibili.ts";
import { githubExtractor } from "./github.ts";
import { hackernewsExtractor } from "./hackernews.ts";
import { redditExtractor } from "./reddit.ts";
import { wechatExtractor } from "./wechat.ts";

// Registry of domain-specific extractors. To add a site: write an Extractor
// module and push it here — same pattern as web-search's `registerBackend`.
//
// Note on zhihu.com: no server-side extractor here. Zhihu's API requires a
// dynamic x-zse-96 signature and the HTML page returns a CAPTCHA wall to
// anonymous fetches (Jina Reader also fails). Use `opencli zhihu ...` from
// the user's logged-in browser session instead.
const EXTRACTORS: Extractor[] = [
	bilibiliExtractor,
	githubExtractor,
	redditExtractor,
	hackernewsExtractor,
	wechatExtractor,
];

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
