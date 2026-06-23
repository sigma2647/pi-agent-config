// Jina Reader fallback engine for pi-wf.
//
// Server-side rendering service (r.jina.ai) that executes JS and returns
// markdown. Used as a middle-chain fallback for pages that Readability can't
// handle but don't warrant a full headless browser.

import type { FetchContext, FetchResult } from "../core.ts";
import { extractHeadingTitle } from "./readability.ts";

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30000;

export async function extractWithJinaReader(
	ctx: FetchContext,
): Promise<FetchResult | null> {
	try {
		const res = await fetch(JINA_READER_BASE + ctx.url, {
			headers: { Accept: "text/markdown", "X-No-Cache": "true" },
			dispatcher: ctx.dispatcher,
			signal: AbortSignal.any([
				AbortSignal.timeout(JINA_TIMEOUT_MS),
				...(ctx.signal ? [ctx.signal] : []),
			]),
		});
		if (!res.ok) return null;

		const content = await res.text();
		const contentStart = content.indexOf("Markdown Content:");
		if (contentStart < 0) return null;

		const markdownPart = content.slice(contentStart + 17).trim();
		if (
			markdownPart.length < 100 ||
			markdownPart.startsWith("Loading...") ||
			markdownPart.startsWith("Please enable JavaScript")
		) {
			return null;
		}

		const title =
			extractHeadingTitle(markdownPart) ??
			new URL(ctx.url).pathname.split("/").pop() ??
			ctx.url;
		return { url: ctx.url, title, content: markdownPart, error: null };
	} catch {
		return null;
	}
}
