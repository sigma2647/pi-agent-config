import type { FetchResult } from "../core.ts";
import { type Extractor, fetchJson } from "./types.ts";

// news.ycombinator.com/item?id=N → Algolia's HN API gives the full nested
// thread as JSON, which we flatten to markdown.

interface HnItem {
	id: number;
	title?: string;
	author?: string;
	text?: string;
	url?: string;
	points?: number;
	type?: string;
	children?: HnItem[];
}

function stripHtml(s: string | undefined): string {
	if (!s) return "";
	return s
		.replace(/<p>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&#x2F;/g, "/")
		.trim();
}

function renderItem(item: HnItem, depth: number, lines: string[], max: number): void {
	if (lines.length > max) return;
	const indent = "  ".repeat(depth);
	const author = item.author || "[deleted]";
	const text = stripHtml(item.text);
	if (text) lines.push(`${indent}- **${author}**: ${text.replace(/\n+/g, " ")}`);
	for (const child of item.children || []) {
		renderItem(child, depth + 1, lines, max);
	}
}

export const hackernewsExtractor: Extractor = {
	name: "hackernews",
	match: (url) =>
		(url.hostname === "news.ycombinator.com" || url.hostname === "hn.algolia.com") &&
		!!url.searchParams.get("id"),
	async extract(ctx, url) {
		const id = url.searchParams.get("id");
		if (!id) return null;
		const item = await fetchJson<HnItem>(ctx, `https://hn.algolia.com/api/v1/items/${id}`);
		if (!item) return null;

		const title = item.title || `HN item ${id}`;
		const lines: string[] = [`# ${title}`, ""];
		if (item.url) lines.push(`> Link: ${item.url}`);
		lines.push(`> by ${item.author || "?"} · ${item.points ?? 0} points · https://news.ycombinator.com/item?id=${id}`, "", "---", "");
		const story = stripHtml(item.text);
		if (story) lines.push(story, "");

		if (item.children && item.children.length > 0) {
			lines.push("## Comments", "");
			for (const child of item.children) renderItem(child, 0, lines, 300);
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
