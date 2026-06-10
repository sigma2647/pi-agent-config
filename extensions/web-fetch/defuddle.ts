// Defuddle (library API) wrapper for pi-wf.
//
// Article extractor from https://github.com/kepano/defuddle.
// We use a wrapper to silence internal library noise (noisy URL warnings)
// and to perform pre-processing (like fixing relative canonical links)
// that improves the library's extraction success rate.

import { parseHTML } from "linkedom";
import type { FetchContext, FetchResult } from "./core.ts";
import { BROWSER_HEADERS } from "./core.ts";

type DefuddleFn = (
	input: any, // Document | string
	url?: string,
	options?: { markdown?: boolean; debug?: boolean; url?: string },
) => Promise<{
	title?: string;
	author?: string;
	published?: string;
	description?: string;
	content?: string;
	wordCount?: number;
}>;

let cachedDefuddle: DefuddleFn | null | undefined;

async function loadDefuddle(): Promise<DefuddleFn | null> {
	if (cachedDefuddle !== undefined) return cachedDefuddle;
	try {
		const m: any = await import("defuddle/node");
		cachedDefuddle = (m.Defuddle ?? m.default?.Defuddle ?? null) as DefuddleFn | null;
	} catch {
		cachedDefuddle = null;
	}
	return cachedDefuddle;
}

/**
 * Extract content using the Defuddle library.
 * Falls through (returns null) if the library is missing or if content is too thin.
 */
export async function extractWithDefuddle(
	ctx: FetchContext,
	prefetchedHtml?: string,
	minUsefulContent = 500,
): Promise<FetchResult | null> {
	const Defuddle = await loadDefuddle();
	if (!Defuddle) return null;

	try {
		let html = prefetchedHtml;
		if (!html) {
			const res = await fetch(ctx.url, {
				signal: ctx.signal,
				dispatcher: ctx.dispatcher,
				headers: BROWSER_HEADERS,
			});
			if (!res.ok) return null;
			html = await res.text();
		}
		if (ctx.signal?.aborted) return null;

		const { document } = parseHTML(html);

		// Silence noisy "Failed to parse URL" warnings from defuddle's metadata
		// extractor (it often trips on relative canonical links).
		const originalWarn = console.warn;
		console.warn = (...args: any[]) => {
			if (typeof args[0] === "string" && args[0].includes("Failed to parse URL:")) return;
			originalWarn(...args);
		};

		try {
			// Try to assist the extractor by making the canonical link absolute
			// if it exists and is relative.
			const canonical = document.querySelector('link[rel="canonical"]');
			const href = canonical?.getAttribute("href");
			if (href && !href.startsWith("http")) {
				try { canonical!.setAttribute("href", new URL(href, ctx.url).href); } catch { /* skip */ }
			}

			const r = await Defuddle(document, ctx.url, { markdown: true });
			const markdown = (r.content ?? "").trim();
			if (markdown.length < minUsefulContent) return null;

			const meta: string[] = [];
			if (r.author) meta.push(`作者: ${r.author}`);
			if (r.published) meta.push(`发布: ${r.published.slice(0, 10)}`);
			if (r.wordCount) meta.push(`字数: ${r.wordCount}`);

			const lines: string[] = [];
			if (meta.length) lines.push(`> ${meta.join(" · ")}`, "");
			if (r.description) lines.push(`> ${r.description}`, "");
			if (meta.length || r.description) lines.push("");
			lines.push(markdown);

			return {
				url: ctx.url,
				title: r.title ?? "",
				content: lines.join("\n"),
				error: null,
			};
		} finally {
			console.warn = originalWarn;
		}
	} catch (e) {
		// FetchContext carries no debug flag; gate on the env var directly
		// (same signal core.ts uses: opts.debug || PI_WF_DEBUG === "1").
		if (process.env.PI_WF_DEBUG === "1") {
			process.stderr.write(`[pi-wf] defuddle failed: ${(e as Error)?.message ?? e}\n`);
		}
		return null;
	}
}
