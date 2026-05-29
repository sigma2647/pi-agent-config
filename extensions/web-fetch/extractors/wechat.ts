import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { FetchResult } from "../core.ts";
import { type Extractor, fetchText } from "./types.ts";

// 微信公众号文章 (mp.weixin.qq.com/s/...) 把正文容器写成
//   <div id="js_content" style="visibility: hidden; opacity: 0;">
// 等 JS 运行后才显示。Readability 看到 visibility:hidden 就跳过，导致
// 通用 pipeline 提取出的 markdown < MIN_USEFUL_CONTENT 报"incomplete"。
// 实际上 HTML 里有完整 SSR 正文，直接取 #js_content 即可。

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function pickMeta(html: string, attr: string, value: string): string | null {
	const re = new RegExp(
		`<meta\\s+[^>]*${attr}=["']${value}["'][^>]*content=["']([^"']+)["']`,
		"i",
	);
	const m = html.match(re);
	if (m) return decodeEntities(m[1]);
	const re2 = new RegExp(
		`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*${attr}=["']${value}["']`,
		"i",
	);
	const m2 = html.match(re2);
	return m2 ? decodeEntities(m2[1]) : null;
}

function pickJsVar(html: string, name: string): string | null {
	const m = html.match(new RegExp(`var\\s+${name}\\s*=\\s*["']([^"']*)["']`));
	return m ? m[1] : null;
}

function safeDate(unixSec: string | null): string {
	if (!unixSec) return "";
	const n = Number(unixSec);
	if (!Number.isFinite(n) || n <= 0) return "";
	const d = new Date(n * 1000);
	return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

async function extractWechat(
	url: URL,
	signal?: AbortSignal,
): Promise<FetchResult | null> {
	const html = await fetchText(url.href, signal);
	if (!html) return null;

	// 微信偶尔会跳到"环境异常"反爬页面，那种页面没有 js_content。
	if (!html.includes('id="js_content"')) return null;

	const title =
		pickMeta(html, "property", "og:title") ??
		pickJsVar(html, "msg_title") ??
		"";
	const author =
		pickMeta(html, "name", "author") ?? pickJsVar(html, "nickname") ?? "";
	const pubDate = safeDate(pickJsVar(html, "ct"));

	const { document } = parseHTML(html);
	const node = document.getElementById("js_content");
	if (!node) return null;

	// Strip visibility:hidden so anything downstream that respects it sees real
	// content. We're going to convert by hand anyway, but be defensive.
	node.removeAttribute("style");

	// 微信的代码块用 <section> 嵌套，turndown 默认会丢格式。直接转就够用。
	const markdown = turndown.turndown(node.innerHTML).trim();
	if (markdown.length < 50) return null;

	const meta: string[] = [];
	if (author) meta.push(`作者: ${author}`);
	if (pubDate) meta.push(`发布: ${pubDate}`);

	const lines: string[] = [];
	if (title) lines.push(`# ${title}`, "");
	if (meta.length) lines.push(`> ${meta.join(" · ")}`, "");
	if (title || meta.length) lines.push("---", "");
	lines.push(markdown);

	return {
		url: url.href,
		title,
		content: lines.join("\n"),
		error: null,
	};
}

export const wechatExtractor: Extractor = {
	name: "wechat",
	match: (url) =>
		url.hostname === "mp.weixin.qq.com" && url.pathname.startsWith("/s/"),
	extract: extractWechat,
};
