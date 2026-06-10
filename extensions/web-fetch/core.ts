import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { ProxyAgent } from "undici";
import { dispatchExtractor } from "./extractors/index.ts";
import { loadPlaywright as resolvePlaywright } from "./playwright.ts";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 20 * 1024 * 1024;
const MIN_USEFUL_CONTENT = 500;
const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30000;

// ── Fetch execution context ───────────────────────────────────────────
// Every fetch helper, every extractor, every diagnostic function takes a
// FetchContext instead of `(url, signal, proxy?, ...)`. Adding a new
// per-request option (timeout, userAgent, custom headers, ...) is a
// one-line change to this interface plus the makeContext builder; no
// signatures down the chain need to move. The dispatcher is built once
// when the ctx is created and reused across the whole fallback chain.

export interface FetchContext {
	/** The page URL being fetched. */
	url: string;
	/** Caller-supplied cancellation signal. */
	signal?: AbortSignal;
	/** Explicit proxy URL (overrides env). Falls back to env when absent. */
	proxy?: string;
	/**
	 * Pre-built undici dispatcher. `undefined` means "use undici default"
	 * which respects EnvHttpProxyAgent (i.e. `HTTP_PROXY` / `HTTPS_PROXY`).
	 */
	dispatcher?: import("undici").Dispatcher;
}

/** Build a `ProxyAgent` once for the given explicit proxy URL. */
function makeDispatcher(proxy?: string): import("undici").Dispatcher | undefined {
	if (!proxy) return undefined;
	try {
		return new ProxyAgent(proxy);
	} catch {
		return undefined;
	}
}

/** Build a FetchContext with the dispatcher cached. Call once per fetchAndExtract. */
export function makeContext(
	url: string,
	signal?: AbortSignal,
	opts?: { proxy?: string },
): FetchContext {
	return {
		url,
		signal,
		proxy: opts?.proxy,
		dispatcher: makeDispatcher(opts?.proxy),
	};
}

/** Resolved proxy URL for display / error messages / Chromium config. */
export function effectiveProxy(ctx: FetchContext): string {
	return ctx.proxy ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? "";
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

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

export interface FetchResult {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

// ── PDF Extraction ───────────────────────────────────────────────────

function isPDF(url: string, contentType?: string): boolean {
	if (contentType?.includes("application/pdf")) return true;
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

async function extractPDF(
	buffer: ArrayBuffer,
	url: string,
): Promise<FetchResult> {
	const { getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(new Uint8Array(buffer));

	const metadata = await pdf.getMetadata();
	const metadataInfo =
		metadata.info && typeof metadata.info === "object"
			? (metadata.info as Record<string, unknown>)
			: null;

	const metaTitle =
		typeof metadataInfo?.Title === "string"
			? metadataInfo.Title.trim()
			: "";
	const metaAuthor =
		typeof metadataInfo?.Author === "string"
			? metadataInfo.Author.trim()
			: "";

	let urlTitle = "document";
	try {
		const { basename } = await import("node:path");
		urlTitle =
			basename(new URL(url).pathname, ".pdf")
				.replace(/[_-]+/g, " ")
				.trim() || "document";
	} catch {
		/* ignore */
	}
	const title = metaTitle || urlTitle;

	const maxPages = Math.min(pdf.numPages, 100);
	const pages: string[] = [];
	for (let i = 1; i <= maxPages; i++) {
		const page = await pdf.getPage(i);
		const textContent = await page.getTextContent();
		const pageText = textContent.items
			.map((item: unknown) => (item as { str?: string }).str || "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (pageText) pages.push(pageText);
	}

	const lines: string[] = [
		`# ${title}`,
		"",
		`> Source: ${url}`,
		`> Pages: ${pdf.numPages}${pdf.numPages > maxPages ? ` (extracted first ${maxPages})` : ""}`,
	];
	if (metaAuthor) lines.push(`> Author: ${metaAuthor}`);
	lines.push("", "---", "");
	lines.push(pages.join("\n\n"));

	if (pdf.numPages > maxPages) {
		lines.push(
			"",
			"---",
			"",
			`*[Truncated: Only first ${maxPages} of ${pdf.numPages} pages extracted]*`,
		);
	}

	return { url, title, content: lines.join("\n"), error: null };
}

// ── RSC Content Extraction (Next.js) ─────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────

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

function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

// ── Defuddle (library API) ───────────────────────────────────────────
// Article extractor from https://github.com/kepano/defuddle. Used to live as a
// CLI subprocess + tmpfile dance (~4s per call, half of which was Node startup
// and JSON serialization). The `defuddle/node` bundle exposes the same engine
// as a function — we feed it the linkedom Document we already have and skip
// the subprocess entirely. ~10x faster (~400ms total) and reuses the proxy-
// aware HTML fetch we did in extractViaHttp.
//
// Why prefer defuddle over Readability for certain sites: it standardizes
// footnotes / code blocks / callouts / math at the DOM level *before* Markdown
// conversion, producing Pandoc-style `[^N]:` instead of wiki backref junk.
// For citation-heavy pages (wikis, academic articles) it is dramatically
// cleaner. For blogs/news, Readability is usually equivalent and faster.

type DefuddleFn = (
	input: Document | string,
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

let defuddleFn: DefuddleFn | null | undefined;

async function loadDefuddle(): Promise<DefuddleFn | null> {
	if (defuddleFn !== undefined) return defuddleFn;
	try {
		const m: any = await import("defuddle/node");
		defuddleFn = (m.Defuddle ?? m.default?.Defuddle ?? null) as DefuddleFn | null;
	} catch {
		defuddleFn = null;
	}
	return defuddleFn;
}

async function extractWithDefuddle(
	ctx: FetchContext,
	prefetchedHtml?: string,
): Promise<FetchResult | null> {
	const Defuddle = await loadDefuddle();
	if (!Defuddle) return null;
	try {
		// Reuse HTML if extractViaHttp already fetched it (--defuddle path
		// passes it through); otherwise fetch ourselves using ctx's dispatcher.
		let html = prefetchedHtml;
		if (!html) {
			const res = await fetch(ctx.url, {
				signal: ctx.signal,
				dispatcher: ctx.dispatcher,
				headers: {
					"User-Agent": USER_AGENT,
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.9",
					"Cache-Control": "no-cache",
					"Sec-Fetch-Dest": "document",
					"Sec-Fetch-Mode": "navigate",
					"Sec-Fetch-Site": "none",
					"Sec-Fetch-User": "?1",
					"Upgrade-Insecure-Requests": "1",
				},
			});
			if (!res.ok) return null;
			html = await res.text();
		}
		if (ctx.signal?.aborted) return null;

		const { document } = parseHTML(html);
		const r = await Defuddle(document, ctx.url, { markdown: true });
		const markdown = (r.content ?? "").trim();
		if (markdown.length < MIN_USEFUL_CONTENT) return null;

		const meta: string[] = [];
		if (r.author) meta.push(`作者: ${r.author}`);
		if (r.published) meta.push(`发布: ${r.published.slice(0, 10)}`);
		if (r.wordCount) meta.push(`字数: ${r.wordCount}`);

		// Don't repeat the title inside `content` — dev.ts derives a `# title`
		// header from `result.title`. Only emit extras that wouldn't otherwise
		// surface (meta line + description).
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
	} catch {
		return null;
	}
}

// ── Playwright Fallback (persistent profile) ─────────────────────────
// Last-resort fallback for pages that block all anonymous server-side fetches
// (zhihu, weibo, xhs etc.). Launches headless Chromium with a persistent
// user-data-dir so cookies/login state survive across calls.
//
// First-time setup for a new site: run tools/login_bootstrap.ts <url>,
// log in manually, close. After that pi-wf can reuse the cookies.
//
// Disabled by default unless PI_WF_PLAYWRIGHT=1 (Playwright is an optional
// peerDep and Chromium startup adds ~2s).

const PLAYWRIGHT_TIMEOUT_MS = 30000;
const PLAYWRIGHT_SETTLE_MS = 1500;
const PLAYWRIGHT_PROFILE_DIR =
	process.env.PI_WF_PROFILE ??
	`${process.env.HOME ?? ""}/.pw-capture-profile`;

// Minimal stealth init script — patches the headless tells that anti-bot
// scripts check first (navigator.webdriver, window.chrome, userAgentData,
// platform). Adapted from tiktok_clawler/config.py. Injected via
// `addInitScript` so it runs in every frame before page scripts. Heavier
// alternatives (puppeteer-extra-plugin-stealth.min.js, ~180 KB) exist but
// this 20-line version is enough for most CN sites.
const STEALTH_SCRIPT = `
  delete navigator.__proto__.webdriver;
  window.chrome = { runtime: {} };
  Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  if (!navigator.userAgentData) {
    Object.defineProperty(navigator, 'userAgentData', {
      value: {
        brands: [
          { brand: "Chromium", version: "122" },
          { brand: "Google Chrome", version: "122" },
          { brand: "Not:A-Brand", version: "24" }
        ],
        mobile: false,
        platform: "macOS",
        getHighEntropyValues: async () => ({
          architecture: "arm", model: "", platform: "macOS",
          platformVersion: "14.0.0", uaFullVersion: "122.0.0.0"
        })
      },
      writable: false, configurable: false
    });
  }
  // WebGL vendor/renderer spoof — many headless checks call this.
  const _getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (p) {
    if (p === 37445) return 'Intel Inc.';            // UNMASKED_VENDOR_WEBGL
    if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
    return _getParameter.call(this, p);
  };
  // Permissions API: report 'prompt' instead of 'denied' for notifications.
  const _query = navigator.permissions && navigator.permissions.query;
  if (_query) {
    navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : _query.call(navigator.permissions, p);
  }
`;

// Hosts that always block anonymous server-side fetches — we auto-enable the
// Playwright fallback for these without requiring PI_WF_PLAYWRIGHT=1. The user
// still has to do a one-time `pi-wf --login <url>` to seed cookies.
const PLAYWRIGHT_AUTO_HOSTS = /(?:^|\.)(zhihu|weibo|xiaohongshu)\.com$/i;

function playwrightWantedFor(url: string): boolean {
	if (process.env.PI_WF_PLAYWRIGHT === "0") return false;
	if (process.env.PI_WF_PLAYWRIGHT === "1") return true;
	try {
		return PLAYWRIGHT_AUTO_HOSTS.test(new URL(url).hostname);
	} catch {
		return false;
	}
}

const loadPlaywright = resolvePlaywright;

async function extractWithPlaywright(
	ctx: FetchContext,
): Promise<FetchResult | null> {
	if (!playwrightWantedFor(ctx.url)) return null;
	const pw = await loadPlaywright();
	if (!pw) return null;

	// Chromium is a separate process — it does NOT honor `NODE_USE_ENV_PROXY`
	// or the undici dispatcher. The only way to route Chromium through a proxy
	// is the `proxy` launch option. We mirror the env-or-explicit precedence
	// used by every other extractor via effectiveProxy().
	const proxy = effectiveProxy(ctx);

	const browser = await pw.chromium.launchPersistentContext(PLAYWRIGHT_PROFILE_DIR, {
		headless: true,
		userAgent: USER_AGENT,
		viewport: { width: 1280, height: 800 },
		locale: "zh-CN",
		proxy: proxy ? { server: proxy } : undefined,
		args: [
			"--disable-blink-features=AutomationControlled",
			"--disable-dev-shm-usage",
			"--no-sandbox",
		],
	});
	await browser.addInitScript(STEALTH_SCRIPT);

	let html: string | null = null;
	try {
		const page = await browser.newPage();
		const onAbort = () => page.close().catch(() => {});
		ctx.signal?.addEventListener("abort", onAbort);
		try {
			await page
				.goto(ctx.url, { waitUntil: "domcontentloaded", timeout: PLAYWRIGHT_TIMEOUT_MS })
				.catch(() => {}); // some SPAs never fire DOMContentLoaded — keep going
			await page.waitForTimeout(PLAYWRIGHT_SETTLE_MS);
			html = await page.content();
		} finally {
			ctx.signal?.removeEventListener("abort", onAbort);
		}
	} catch {
		html = null;
	} finally {
		await browser.close().catch(() => {});
	}

	if (!html) return null;

	// Bail early if it's the obvious anti-bot wall — don't return "安全验证"
	// as the title.
	if (/安全验证|请您登录|please log\s*in|captcha required/i.test(html.slice(0, 2000))) {
		return null;
	}

	const { document } = parseHTML(html);
	const reader = new Readability(document as unknown as Document);
	const article = reader.parse();
	if (!article) return null;

	const markdown = postProcessMarkdown(turndown.turndown(article.content), ctx.url);
	if (markdown.length < MIN_USEFUL_CONTENT) return null;
	return {
		url: ctx.url,
		title: article.title || "",
		content: markdown,
		error: null,
	};
}

// ── Jina Reader Fallback ─────────────────────────────────────────────

async function extractWithJinaReader(
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

// ── Main HTTP Extraction ─────────────────────────────────────────────

async function extractViaHttp(ctx: FetchContext): Promise<FetchResult> {
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
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
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

		const markdown = postProcessMarkdown(turndown.turndown(article.content), url);

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
	const proxy = effectiveProxy(ctx);
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

// ── Public Fetch Function ────────────────────────────────────────────

export interface FetchOptions {
	debug?: boolean;
	preferDefuddle?: boolean;
	proxy?: string;
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

	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}

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
	const ctx = makeContext(url, signal, { proxy: opts.proxy });

	log(`url: ${url}`);
	log(`host: ${parsedUrl.hostname}  proxy: ${effectiveProxy(ctx) || "(none)"}`);
	log(`mode: ${preferDefuddle ? "defuddle-primary" : "readability-primary"}`);

	// Domain-specific extractors first (reddit/github/HN/…). On decline they
	// return null and we fall through to the generic Readability/Jina pipeline.
	const domainResult = await time("domain-extractor", () =>
		dispatchExtractor(ctx, parsedUrl),
	);
	if (domainResult) {
		log("→ returning: domain-extractor");
		return domainResult;
	}
	if (signal?.aborted) return { url, title: "", content: "", error: "Aborted" };

	// Defuddle-primary path: try defuddle FIRST (cleaner Pandoc footnotes,
	// schema.org metadata, more complete section structure). Falls through to
	// Readability if defuddle isn't installed / errors / returns too little.
	if (preferDefuddle) {
		const r = await time("defuddle (primary)", () => extractWithDefuddle(ctx));
		if (r) {
			log("→ returning: defuddle (primary)");
			return r;
		}
		if (signal?.aborted) return { url, title: "", content: "", error: "Aborted" };
		log("defuddle returned null — falling through to Readability");
	}

	const httpResult = await time("http+Readability", () => extractViaHttp(ctx));
	if (signal?.aborted)
		return { url, title: "", content: "", error: "Aborted" };
	if (!httpResult.error) {
		log("→ returning: http+Readability");
		return httpResult;
	}
	log(`http+Readability failed: ${httpResult.error.split("\n")[0]}`);

	if (
		httpResult.error.startsWith("Unsupported content type") ||
		httpResult.error.startsWith("Response too large") ||
		httpResult.error.startsWith("fetch failed") ||
		httpResult.error.startsWith("HTTP 5")
	) {
		// Network/server-level failures are a dead end — extra fallbacks
		// (defuddle, Jina, playwright) all hit the same wall. Return the
		// diagnostic error from describeNetworkError without the misleading
		// "may be JS-rendered or login-gated" suffix.
		log("→ returning: http error (network/content/server — no fallback)");
		return httpResult;
	}

	// Skip the middle-chain defuddle if defuddle-primary already ran it once
	// and it returned null. Would waste ~300ms re-doing the same work.
	if (!preferDefuddle) {
		const defuddleResult = await time("defuddle", () => extractWithDefuddle(ctx));
		if (defuddleResult) {
			log("→ returning: defuddle");
			return defuddleResult;
		}
		if (signal?.aborted)
			return { url, title: "", content: "", error: "Aborted" };
	} else {
		log("defuddle (middle): skipped (already tried as forced)");
	}

	const jinaResult = await time("jina-reader", () => extractWithJinaReader(ctx));
	if (jinaResult) {
		log("→ returning: jina-reader");
		return jinaResult;
	}
	if (signal?.aborted)
		return { url, title: "", content: "", error: "Aborted" };

	const playwrightResult = await time("playwright", () => extractWithPlaywright(ctx));
	if (playwrightResult) {
		log("→ returning: playwright");
		return playwrightResult;
	}
	if (signal?.aborted)
		return { url, title: "", content: "", error: "Aborted" };
	log("→ all fallbacks exhausted");

	const hints = [
		"The page may be JavaScript-rendered or login-gated. Try:",
		"  • A different URL for the same content",
		"  • web_search to find cached/alternative versions",
	];
	const needsLogin = PLAYWRIGHT_AUTO_HOSTS.test(parsedUrl.hostname);
	const isAuthError = /HTTP (401|403|429)\b/.test(httpResult.error);
	if (needsLogin) {
		hints.push(
			`  • This host blocks anonymous requests — seed cookies once:`,
			`      pi-wf --login ${parsedUrl.origin}`,
		);
	} else if (isAuthError) {
		hints.push(
			`  • If the page requires sign-in, seed cookies once via:`,
			`      pi-wf --login ${parsedUrl.origin}`,
		);
	}
	return {
		...httpResult,
		error: `${httpResult.error}\n\n${hints.join("\n")}`,
	};
}
