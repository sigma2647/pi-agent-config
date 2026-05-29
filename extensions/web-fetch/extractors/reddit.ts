import type { FetchResult } from "../core.ts";
import { type Extractor, fetchJson } from "./types.ts";

// Reddit exposes a clean JSON view of any post/listing by appending `.json`.
// Far more reliable than scraping the JS-rendered page.

interface RedditThing {
	kind: string;
	data: Record<string, any>;
}

function decode(s: string | undefined): string {
	if (!s) return "";
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"');
}

function renderComments(children: RedditThing[], depth: number, lines: string[], max: number): void {
	for (const child of children) {
		if (child.kind !== "t1" || lines.length > max) continue;
		const d = child.data;
		const indent = "  ".repeat(depth);
		const author = d.author || "[deleted]";
		const score = typeof d.score === "number" ? ` (${d.score})` : "";
		const body = decode(d.body || "").trim();
		if (body) {
			lines.push(`${indent}- **${author}**${score}: ${body.replace(/\n+/g, " ")}`);
		}
		const replies = d.replies;
		if (replies && typeof replies === "object" && replies.data?.children && depth < 4) {
			renderComments(replies.data.children as RedditThing[], depth + 1, lines, max);
		}
	}
}

export const redditExtractor: Extractor = {
	name: "reddit",
	match: (url) => /(^|\.)reddit\.com$/.test(url.hostname),
	async extract(ctx, url) {
		// Normalize old./www./np. → a .json endpoint on the canonical host.
		const jsonUrl = `https://www.reddit.com${url.pathname.replace(/\/$/, "")}.json?limit=100&raw_json=1`;
		const data = await fetchJson<any>(ctx, jsonUrl);
		if (!Array.isArray(data) || data.length === 0) return null;

		const postListing = data[0]?.data?.children?.[0]?.data;
		if (!postListing) return null;

		const title = decode(postListing.title) || "Reddit post";
		const author = postListing.author || "[deleted]";
		const score = postListing.score ?? 0;
		const subreddit = postListing.subreddit_name_prefixed || "";
		const selftext = decode(postListing.selftext || "").trim();
		const linkUrl = postListing.url_overridden_by_dest;

		const lines: string[] = [
			`# ${title}`,
			"",
			`> ${subreddit} · u/${author} · ${score} points · ${postListing.num_comments ?? 0} comments`,
		];
		if (linkUrl && linkUrl !== url.href) lines.push(`> Link: ${linkUrl}`);
		lines.push("", "---", "");
		if (selftext) lines.push(selftext, "");

		const commentListing = data[1]?.data?.children;
		if (Array.isArray(commentListing) && commentListing.length > 0) {
			lines.push("## Top comments", "");
			renderComments(commentListing as RedditThing[], 0, lines, 200);
		}

		const result: FetchResult = {
			url: url.href,
			title,
			content: lines.join("\n"),
			error: null,
		};
		return result;
	},
};
