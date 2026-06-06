import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { fetchAndExtract } from "./core.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a single URL and return the full page as clean markdown — the right tool whenever you need to READ a page (docs, blog post, GitHub issue, PDF, API reference, news article, RFC). " +
			"Pairs with web_search: search finds URLs, fetch reads them. " +
			"Handles HTML (Readability/Defuddle), PDFs, plain text, and JS-rendered pages via Jina/Playwright fallback.",
		promptSnippet:
			"Fetch a URL and extract its readable content as markdown.",
		promptGuidelines: [
			"Use web_fetch whenever you need the actual content of a known URL, including URLs returned by web_search.",
			"Default to web_fetch over web_search when the user names a specific resource or gives a URL (e.g. 'check the React docs', 'read this RFC', 'open this PR', 'look at <url>').",
			"After web_search returns useful-looking results, follow up with web_fetch on the top URL(s) instead of answering from snippets — snippets are previews, not source.",
		],

		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			proxy: Type.Optional(Type.String({ description: "Proxy URL (e.g. http://127.0.0.1:7890)" })),
		}),

		async execute(_toolCallId, params, signal) {
			const result = await fetchAndExtract(params.url, signal, { proxy: params.proxy });

			if (result.error) {
				throw new Error(`${params.url}: ${result.error}`);
			}

			const header = result.title
				? `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n`
				: "";
			return {
				content: [
					{
						type: "text" as const,
						text: header + result.content,
					},
				],
				details: {
					url: result.url,
					title: result.title,
					chars: result.content.length,
				},
			};
		},

		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);
			const { url } = args as { url?: string };
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
			};

			const title = details?.title || "Untitled";
			const chars = details?.chars ?? 0;
			const status =
				theme.fg("success", title) +
				theme.fg("muted", ` (${chars} chars)`);

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
