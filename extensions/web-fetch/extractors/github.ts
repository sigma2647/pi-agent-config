import type { FetchResult } from "../core.ts";
import { type Extractor, fetchText } from "./types.ts";

// For github.com/<owner>/<repo>/blob/<ref>/<path> URLs, fetch the raw file
// instead of the JS-heavy blob viewer. Other github.com URLs (issues, PRs,
// repo home) decline → generic pipeline handles them.

const BLOB_RE = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;

export const githubExtractor: Extractor = {
	name: "github",
	match: (url) => url.hostname === "github.com" && BLOB_RE.test(url.pathname),
	async extract(url, signal) {
		const m = url.pathname.match(BLOB_RE);
		if (!m) return null;
		const [, owner, repo, ref, filePath] = m;
		const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
		const text = await fetchText(rawUrl, signal);
		if (text === null) return null;

		const ext = filePath.includes(".") ? filePath.split(".").pop() : "";
		const fence = ext ? "```" + ext : "```";
		const content = `# ${owner}/${repo} — ${filePath}\n\n> Raw: ${rawUrl}\n\n${fence}\n${text}\n\`\`\``;

		const result: FetchResult = {
			url: url.href,
			title: `${owner}/${repo}: ${filePath}`,
			content,
			error: null,
		};
		return result;
	},
};
