// HTTP + Readability extraction engine for pi-wf.
//
// The primary generic extraction path: fetch → Readability → Turndown → postProcessMarkdown.
// Also handles plain text, RSC (Next.js Server Components), and delegates PDFs to ./pdf.ts.

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { FetchContext, FetchResult } from "../core.ts";
import { BROWSER_HEADERS, MIN_USEFUL_CONTENT } from "../core.ts";
import { isPDF, extractPDF, MAX_PDF_SIZE } from "./pdf.ts";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

// ── Markdown post-processing ────────────────────────────────────────────
// Clean up Turndown's raw output: drop decorative images, absolutize relative
// links, collapse wiki citation backref junk. Cheap regex pass — adds ~1ms.
// Sources of noise this targets (counted on a typical wiki article):
//   • empty-alt images (~3): `![](/path.svg)` — purely decorative
//   • icon images: `![Ambox_…](…)` / `![本页使用了…](…)` — wiki maintenance UI
//   • backref clusters: `16.  ^ [**16.00**](#cite_ref-…) [**16.01**](…) …`
//   • single backrefs: `17.  **[^](#cite_ref-17)** text`
//   • relative URLs: `](/wiki/X)` / `](/w/index.php?…)` — break when copied out

function postProcessMarkdown(md: string, baseUrl: string): string {
	let out = md;

	// 1. Drop low-information image lines
	out = out.replace(/^!\[\]\([^)]+\)\s*$/gm, "");
	out = out.replace(
		/^!\[[^\]]*(?:Ambox|本[页頁]使用了|本[页頁]面|stub|[Ii]con|conversion)[^\]]*\]\([^)]+\)\s*$/gm,
		"",
	);

	// 2. Absolutize relative links — both Markdown links `](path)` and image
	//    srcs. Handles three forms:
	//      ](/path)                   — root-relative
	//      ](/path "title")           — root-relative with Markdown link title
	//      ](//host/path)             — protocol-relative (common on wiki)
	try {
		const base = new URL(baseUrl);
		// Protocol-relative FIRST so it doesn't get caught by the root-relative pass.
		out = out.replace(
			/\]\((\/\/[^\s)]+)(\s+"[^"]*")?\)/g,
			(_m, p, title) => `](${base.protocol}${p}${title || ""})`,
		);
		out = out.replace(
			/\]\((\/[^\s)]+)(\s+"[^"]*")?\)/g,
			(_m, p, title) => `](${base.origin}${p}${title || ""})`,
		);
	} catch {
		/* malformed url, skip */
	}

	// 3. Collapse wiki citation backref clusters
	//    "16.  ^ [**16.00**](#cite_ref-…) [**16.01**](…) … actual text"
	out = out.replace(
		/^(\d+)\.\s+\^\s+(?:\[\*\*[\d.]+\*\*\]\(#cite_ref-[^)]+\)\s*)+/gm,
		"$1. ",
	);
	// Single backref: "17.  **[^](#cite_ref-17)** text"
	out = out.replace(
		/^(\d+)\.\s+\*\*\[\^\]\(#cite_ref-\d+\)\*\*\s*/gm,
		"$1. ",
	);

	// 4. Collapse triple+ blank lines (left over from dropped image lines)
	out = out.replace(/\n{3,}/g, "\n\n");

	return out.trim();
}

/**
 * Run Turndown → postProcessMarkdown in one pass.
 * Exported so playwright.ts can reuse the same HTML→markdown pipeline.
 */
export function htmlToMarkdown(html: string, baseUrl: string): string {
	return postProcessMarkdown(turndown.turndown(html), baseUrl);
}

// ── Heuristics ──────────────────────────────────────────────────────────

function isLikelyJSRendered(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;
	const textContent = bodyMatch[1]
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const scriptCount = (html.match(/<script/gi) || []).length;
	return textContent.length < 500 && scriptCount > 3;
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

// ── RSC Content Extraction (Next.js) ────────────────────────────────────
// Next.js Server Components embed serialized React trees in
// `self.__next_f.push([1,"…"])` script tags. This reconstructs readable
// markdown from the RSC wire format without a browser.

function extractRSCContent(
	html: string,
): { title: string; content: string } | null {
	if (!html.includes("self.__next_f.push")) return null;

	const chunkMap = new Map<string, string>();
	const scriptRegex =
		/<script>self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;

	for (const match of html.matchAll(scriptRegex)) {
		let content: string;
		try {
			content = JSON.parse('"' + match[1] + '"');
		} catch {
			continue;
		}
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			const colonIdx = line.indexOf(":");
			if (colonIdx <= 0 || colonIdx > 4) continue;
			const id = line.slice(0, colonIdx);
			if (!/^[0-9a-f]+$/i.test(id)) continue;
			const payload = line.slice(colonIdx + 1);
			if (!payload) continue;
			const existing = chunkMap.get(id);
			if (!existing || payload.length > existing.length) {
				chunkMap.set(id, payload);
			}
		}
	}

	if (chunkMap.size === 0) return null;

	const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
	const title = titleMatch?.[1]?.split("|")[0]?.trim() || "";

	const parsedCache = new Map<string, unknown>();
	function getParsedChunk(id: string): unknown | null {
		if (parsedCache.has(id)) return parsedCache.get(id);
		const chunk = chunkMap.get(id);
		if (!chunk || !chunk.startsWith("[")) {
			parsedCache.set(id, null);
			return null;
		}
		try {
			const parsed = JSON.parse(chunk);
			parsedCache.set(id, parsed);
			return parsed;
		} catch {
			parsedCache.set(id, null);
			return null;
		}
	}

	type Node = unknown;
	const visitedRefs = new Set<string>();

	function extractNode(node: Node, ctx = { inCode: false }): string {
		if (node === null || node === undefined) return "";
		if (typeof node === "string") {
			const refMatch = node.match(/^\$L([0-9a-f]+)$/i);
			if (refMatch) {
				const refId = refMatch[1];
				if (visitedRefs.has(refId)) return "";
				visitedRefs.add(refId);
				const refNode = getParsedChunk(refId);
				const result = refNode ? extractNode(refNode, ctx) : "";
				visitedRefs.delete(refId);
				return result;
			}
			if (
				!ctx.inCode &&
				(node === "$undefined" ||
					node === "$" ||
					/^\$[A-Z]/.test(node))
			)
				return "";
			return node.trim() ? node : "";
		}
		if (typeof node === "number") return String(node);
		if (typeof node === "boolean") return "";
		if (!Array.isArray(node)) return "";

		if (node[0] === "$" && typeof node[1] === "string") {
			const tag = node[1] as string;
			const props = (node[3] || {}) as Record<string, unknown>;
			const skipTags = [
				"script", "style", "svg", "path", "circle", "link", "meta",
				"template", "button", "input", "nav", "footer", "aside",
			];
			if (skipTags.includes(tag)) return "";

			if (tag.startsWith("$L")) {
				const refId = tag.slice(2);
				if (visitedRefs.has(refId)) return "";
				if (props.baseId && props.children)
					return `## ${String(props.children)}\n\n`;
				visitedRefs.add(refId);
				const refNode = getParsedChunk(refId);
				let result = "";
				if (refNode) result = extractNode(refNode, ctx);
				else if (props.children)
					result = extractNode(props.children as Node, ctx);
				visitedRefs.delete(refId);
				return result;
			}

			const children = props.children;
			const content = children
				? extractNode(children as Node, ctx)
				: "";

			switch (tag) {
				case "h1": return `# ${content.trim()}\n\n`;
				case "h2": return `## ${content.trim()}\n\n`;
				case "h3": return `### ${content.trim()}\n\n`;
				case "h4": return `#### ${content.trim()}\n\n`;
				case "h5": return `##### ${content.trim()}\n\n`;
				case "h6": return `###### ${content.trim()}\n\n`;
				case "p": return `${content.trim()}\n\n`;
				case "code": {
					const cc = children
						? extractNode(children as Node, { inCode: true })
						: "";
					return ctx.inCode ? cc : `\`${cc}\``;
				}
				case "pre": {
					const pc = children
						? extractNode(children as Node, { inCode: true })
						: "";
					return "```\n" + pc + "\n```\n\n";
				}
				case "strong": case "b": return `**${content}**`;
				case "em": case "i": return `*${content}*`;
				case "li": return `- ${content.trim()}\n`;
				case "ul": case "ol": return content + "\n";
				case "blockquote": return `> ${content.trim()}\n\n`;
				case "a": {
					const href = props.href as string | undefined;
					return href && !href.startsWith("#")
						? `[${content}](${href})`
						: content;
				}
				default: return content;
			}
		}

		return (node as Node[]).map((n) => extractNode(n, ctx)).join("");
	}

	const mainChunk = getParsedChunk("23");
	if (mainChunk) {
		const content = extractNode(mainChunk);
		if (content.trim().length > 100) {
			return {
				title,
				content: content.replace(/\n{3,}/g, "\n\n").trim(),
			};
		}
	}

	const contentParts: { order: number; text: string }[] = [];
	for (const [id] of chunkMap) {
		if (id === "23") continue;
		const parsed = getParsedChunk(id);
		if (!parsed) continue;
		visitedRefs.clear();
		const text = extractNode(parsed);
		if (
			text.trim().length > 50 &&
			!text.includes("page was not found") &&
			!text.includes("404")
		) {
			contentParts.push({
				order: parseInt(id, 16),
				text: text.trim(),
			});
		}
	}

	if (contentParts.length === 0) return null;
	contentParts.sort((a, b) => a.order - b.order);

	const seen = new Set<string>();
	const uniqueParts: string[] = [];
	for (const part of contentParts) {
		const key = part.text.slice(0, 150);
		if (!seen.has(key)) {
			seen.add(key);
			uniqueParts.push(part.text);
		}
	}

	const content = uniqueParts
		.join("\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return content.length > 100 ? { title, content } : null;
}

// ── Network error diagnostics ───────────────────────────────────────────
// Node's `fetch` collapses every network failure into a bare `TypeError: fetch
// failed`. The useful info — TCP error code, host that refused, what kind of
// timeout — sits on `err.cause`. Expose it and add ONE actionable next-step
// based on the dominant cause; don't bury the user in advice.

function describeNetworkError(err: unknown, ctx: FetchContext): string {
	if (!(err instanceof Error)) return String(err);
	if (err.name === "AbortError" || err.message === "Aborted") return "Aborted";
	if (err.message !== "fetch failed") return err.message;

	const cause = (err as { cause?: { code?: string; message?: string } }).cause;
	const code = cause?.code ?? "";
	// Report the proxy actually in use (explicit `--proxy` wins over env), not
	// just whatever env says — otherwise the hint misleads when --proxy is set.
	const proxy = ctx.proxy ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? "";
	let host = "";
	try { host = new URL(ctx.url).hostname; } catch { /* malformed url, skip */ }

	const head = code ? `fetch failed (${code})` : "fetch failed";
	let hint = "";
	if (code === "ECONNREFUSED") {
		hint = proxy
			? `proxy ${proxy} refused connection — is Clash/V2Ray running? bypass: HTTPS_PROXY= HTTP_PROXY= pi-wf <url>`
			: `${host} refused the connection`;
	} else if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
		hint = proxy
			? `connect timed out via ${proxy} — proxy reachable but upstream blocked or slow`
			: `connect timed out — ${host} may be blocked; try setting HTTPS_PROXY=http://127.0.0.1:7890`;
	} else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
		hint = `DNS lookup failed for ${host}`;
	} else if (code?.startsWith("CERT_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
		hint = `TLS certificate error — ${cause?.message ?? code}`;
	}
	return hint ? `${head}: ${hint}` : head;
}

// ── Main HTTP Extraction ────────────────────────────────────────────────

export async function extractViaHttp(ctx: FetchContext): Promise<FetchResult> {
	// Alias for readability — body still talks about `url` / `signal` which
	// keeps the original logic clean. Only the signature changed.
	const { url, signal } = ctx;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			dispatcher: ctx.dispatcher,
			headers: BROWSER_HEADERS,
		});

		if (!response.ok) {
			return {
				url, title: "", content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		const contentType = response.headers.get("content-type") || "";
		const contentLengthHeader = response.headers.get("content-length");
		const isPDFContent = isPDF(url, contentType);
		const maxSize = isPDFContent ? MAX_PDF_SIZE : MAX_RESPONSE_SIZE;

		if (contentLengthHeader) {
			const contentLength = parseInt(contentLengthHeader, 10);
			if (contentLength > maxSize) {
				return {
					url, title: "", content: "",
					error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
				};
			}
		}

		if (isPDFContent) {
			const buffer = await response.arrayBuffer();
			return await extractPDF(buffer, url);
		}

		if (
			contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")
		) {
			return {
				url, title: "", content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}

		const text = await response.text();
		const isHTML =
			contentType.includes("text/html") ||
			contentType.includes("application/xhtml+xml");

		if (!isHTML) {
			const title =
				extractHeadingTitle(text) ??
				new URL(url).pathname.split("/").pop() ??
				url;
			return { url, title, content: text, error: null };
		}

		const { document } = parseHTML(text);
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article) {
			const rscResult = extractRSCContent(text);
			if (rscResult) {
				return {
					url,
					title: rscResult.title,
					content: rscResult.content,
					error: null,
				};
			}

			const jsRendered = isLikelyJSRendered(text);
			return {
				url, title: "", content: "",
				error: jsRendered
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Could not extract readable content from HTML structure",
			};
		}

		const markdown = htmlToMarkdown(article.content, url);

		if (markdown.length < MIN_USEFUL_CONTENT) {
			return {
				url,
				title: article.title || "",
				content: markdown,
				error: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content appears incomplete",
			};
		}

		return {
			url,
			title: article.title || "",
			content: markdown,
			error: null,
		};
	} catch (err) {
		return { url, title: "", content: "", error: describeNetworkError(err, ctx) };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}
