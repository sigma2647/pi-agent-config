import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { fetchAndExtract, TRUNCATION_THRESHOLD } from "./core.ts";
import { storeContent, getContent, pruneContent } from "./storage.ts";

function formatBytes(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB`
    : n >= 1000 ? `${(n / 1000).toFixed(1)} KB`
    : `${n} B`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a single URL and return the full page as clean markdown — the right tool whenever you need to READ a page (docs, blog post, GitHub issue, PDF, API reference, news article, RFC). " +
			"Pairs with web_search: search finds URLs, fetch reads them. " +
			"Handles HTML (Readability/Defuddle), PDFs, plain text, and JS-rendered pages via Jina/browser-probe/Playwright fallback.",
		promptSnippet:
			"Fetch a URL and extract its readable content as markdown.",
		promptGuidelines: [
			"Use web_fetch whenever you need the actual content of a known URL, including URLs returned by web_search.",
			"Default to web_fetch over web_search when the user names a specific resource or gives a URL (e.g. 'check the React docs', 'read this RFC', 'open this PR', 'look at <url>').",
			"After web_search returns useful-looking results, follow up with web_fetch on the top URL(s) instead of answering from snippets — snippets are previews, not source.",
			"GitHub commits / releases / repo activity → `gh api <endpoint>` (authenticated, 5000/hr), not web_fetch. web_fetch is for PR/issue/file content.",
			"When web_fetch returns truncated content (>30 KB), the truncated output includes a retrieveId. Use web_fetch({ retrieve: \"<id>\" }) to get the full document without re-fetching.",
		],

		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "URL to fetch. Optional when using `retrieve` to get a previously-truncated document." })),
			proxy: Type.Optional(Type.String({ description: "Proxy URL (e.g. http://127.0.0.1:7890)" })),
			retrieve: Type.Optional(Type.String({ description: "Retrieve a previously-truncated document by its retrieveId instead of fetching" })),
		}),

		async execute(_toolCallId, params, signal) {
			// Retrieval path — return previously-stored full content.
			if (params.retrieve) {
				const cached = getContent(params.retrieve);
				if (!cached) {
					return {
						content: [{ type: "text" as const, text: `⚠️ No stored content for retrieveId "${params.retrieve}". The content may have expired (>30 min) or the id is incorrect.` }],
						details: { retrieveId: params.retrieve, error: "Not found or expired" },
					};
				}
				return {
					content: [{ type: "text" as const, text: cached }],
					details: { retrieveId: params.retrieve, chars: cached.length, fromCache: true },
				};
			}

			if (!params.url) {
				return {
					content: [{ type: "text" as const, text: "⚠️ web_fetch requires either a `url` or a `retrieve` parameter." }],
					details: { error: "Missing url or retrieve parameter" },
				};
			}

			const result = await fetchAndExtract(params.url, signal, { proxy: params.proxy });

			if (result.error) {
				// Return as content rather than throwing — the agent can read the
				// error and try a different URL. Throwing looks like a tool crash
				// and blocks agent-level recovery.
				return {
					content: [{ type: "text" as const, text: `⚠️ Could not fetch ${params.url}: ${result.error}` }],
					details: { url: params.url, error: result.error },
				};
			}

			const header = result.title
				? `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n`
				: "";
			const fullText = header + result.content;

			// Truncation + retrieval: if the content is large, store the full
			// version and return a truncated view. The agent can retrieve the
			// full document with `retrieve: "<id>"`.
			let retrieveId: string | undefined;
			let outputText = fullText;
			if (fullText.length > TRUNCATION_THRESHOLD) {
				retrieveId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
				storeContent(retrieveId, fullText);
				const truncated = fullText.slice(0, TRUNCATION_THRESHOLD);
				const shown = formatBytes(TRUNCATION_THRESHOLD);
				const total = formatBytes(fullText.length);
				outputText = truncated + `\n\n---\n⚠️ Content truncated: ${shown} of ${total} shown.` +
					`\nUse web_fetch({ url: "${result.url}", retrieve: "${retrieveId}" }) to get the full document.`;
			}

			return {
				content: [
					{
						type: "text" as const,
						text: outputText,
					},
				],
				details: {
					url: result.url,
					title: result.title,
					chars: fullText.length,
					...(retrieveId ? { retrieveId, truncated: true } : {}),
				},
			};
		},

		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);
			const { url, retrieve } = args as { url?: string; retrieve?: string };
			if (retrieve) {
				text.setText(
					theme.fg("toolTitle", theme.bold("fetch ")) +
						theme.fg("accent", `retrieve ${retrieve.slice(0, 8)}…`),
				);
				return text;
			}
			if (!url) {
				text.setText(
					theme.fg("toolTitle", theme.bold("fetch ")) +
						theme.fg("error", "(no URL)"),
				);
				return text;
			}
			const display =
				url.length > 70 ? url.slice(0, 67) + "..." : url;
			text.setText(
				theme.fg("toolTitle", theme.bold("fetch ")) +
					theme.fg("accent", display),
			);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);

			if (isPartial) {
				text.setText(theme.fg("warning", "Fetching…"));
				return text;
			}

			if (context.isError) {
				const msg =
					result.content.find((c) => c.type === "text")?.text ||
					"Error";
				text.setText(theme.fg("error", msg));
				return text;
			}

			const details = result.details as {
				title?: string;
				chars?: number;
				truncated?: boolean;
				retrieveId?: string;
				fromCache?: boolean;
			};

			if (details?.fromCache) {
				const label = theme.fg("success", "Retrieved from cache") +
					theme.fg("muted", ` (${details.chars ?? 0} chars)`);
				if (!expanded) return new Text(label, 0, 0);
				const content = result.content.find((c) => c.type === "text")?.text || "";
				const preview = content.length > 500 ? content.slice(0, 500) + "..." : content;
				return new Text(label + "\n" + theme.fg("dim", preview), 0, 0);
			}

			const title = details?.title || "Untitled";
			const chars = details?.chars ?? 0;
			const truncBadge = details?.truncated
				? theme.fg("warning", ` [truncated ${formatBytes(TRUNCATION_THRESHOLD)} of ${formatBytes(chars)}]`)
				: "";
			const status =
				theme.fg("success", title) +
				theme.fg("muted", ` (${chars} chars)`) +
				truncBadge;

			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content =
				result.content.find((c) => c.type === "text")?.text || "";
			const preview =
				content.length > 500
					? content.slice(0, 500) + "..."
					: content;
			text.setText(status + "\n" + theme.fg("dim", preview));
			return text;
		},
	});

	pi.on("session_start", () => {
		pruneContent();
	});

	pi.registerCommand("web-fetch", {
		description: "Fetch a URL and extract markdown (e.g. /web-fetch https://...)",
		handler: async (args, ctx) => {
			const url = args?.trim();
			if (!url) {
				ctx.ui.notify("Usage: /web-fetch <url>", "warning");
				return;
			}
			const signal = ctx.signal ?? new AbortController().signal;
			const result = await fetchAndExtract(url, signal);
			if (result.error) {
				ctx.ui.notify(`ERROR: ${result.error}`, "error");
				return;
			}
			const header = result.title
				? `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n`
				: "";
			ctx.ui.notify(header + result.content, "info");
		},
	});
}
