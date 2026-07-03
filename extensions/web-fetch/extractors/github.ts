import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FetchContext, FetchResult } from "../core.ts";
import { type Extractor, fetchJson, fetchText } from "./types.ts";

// Single GitHub extractor covering:
//   /<owner>/<repo>/blob/<ref>/<path>   → raw file (via raw.githubusercontent.com)
//   /<owner>/<repo>                     → README + repo metadata (via gh CLI or REST)
//   /<owner>/<repo>/issues/<n>          → issue + comments
//   /<owner>/<repo>/pull/<n>            → PR + comments
// Anything else returns null → generic pipeline.

const BLOB_RE = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;
const REPO_RE = /^\/([^/]+)\/([^/]+)\/?$/;
const ISSUE_RE = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)/;
const PR_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

// GitHub-reserved top-level path segments that look like /<owner>/<repo> but
// aren't repos. Cheap pre-filter so we don't hammer api.github.com with 404s.
const RESERVED_TOP = new Set([
	"about", "topics", "trending", "explore", "marketplace", "pricing",
	"settings", "notifications", "issues", "pulls", "discussions", "codespaces",
	"organizations", "orgs", "users", "sponsors", "login", "logout", "join",
	"search", "new", "features", "security", "events",
]);

const execFileP = promisify(execFile);

// ── gh CLI helpers (async, parameterized, never shells out) ────────────

let ghAvailable: boolean | null = null;

async function isGhAvailable(): Promise<boolean> {
	if (ghAvailable !== null) return ghAvailable;
	try {
		await execFileP("gh", ["auth", "status"], {
			env: { ...process.env, GH_TELEMETRY: "off" },
			timeout: 5000,
		});
		ghAvailable = true;
	} catch {
		ghAvailable = false;
	}
	return ghAvailable;
}

/**
 * Run `gh` with explicit argv (never a shell string). Returns stdout on
 * success, null on any failure. Honors caller's AbortSignal.
 */
async function ghRun(args: string[], signal?: AbortSignal): Promise<string | null> {
	if (!(await isGhAvailable())) return null;
	try {
		const { stdout } = await execFileP("gh", args, {
			encoding: "utf-8",
			timeout: 15000,
			signal,
			env: { ...process.env, GH_TELEMETRY: "off" },
			maxBuffer: 8 * 1024 * 1024,
		});
		return stdout;
	} catch {
		return null;
	}
}

async function ghApi<T = unknown>(
	endpoint: string,
	signal?: AbortSignal,
): Promise<T | null> {
	const out = await ghRun(["api", endpoint], signal);
	if (out == null) return null;
	try {
		return JSON.parse(out) as T;
	} catch {
		return null;
	}
}

/**
 * Like `ghApi` but returns the raw response string without JSON.parse.
 */
async function ghApiRaw(
	endpoint: string,
	signal?: AbortSignal,
): Promise<string | null> {
	return ghRun(["api", endpoint], signal);
}

// ── REST API types (minimal) ───────────────────────────────────────────

interface GhRepo {
	full_name: string;
	description: string | null;
	stargazers_count: number;
	forks_count: number;
	open_issues_count: number;
	language: string | null;
	license?: { spdx_id: string } | null;
	homepage: string | null;
	default_branch: string;
	topics?: string[];
}

interface GhIssue {
	number: number;
	title: string;
	body: string | null;
	state: string;
	user?: { login: string };
	created_at: string;
	comments: number;
	labels?: { name: string }[];
	assignees?: { login: string }[];
	html_url: string;
}

interface GhComment {
	user?: { login: string };
	body: string;
	created_at: string;
}

interface GhReadme {
	content: string; // base64
	encoding: string;
	name: string;
	path: string;
}

// ── Path-specific extractors ───────────────────────────────────────────

async function extractBlob(
	ctx: FetchContext,
	url: URL,
): Promise<FetchResult | null> {
	const m = url.pathname.match(BLOB_RE);
	if (!m) return null;
	const [, owner, repo, ref, filePath] = m;
	const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
	const text = await fetchText(ctx, rawUrl);
	if (text === null) return null;

	const ext = filePath.includes(".") ? filePath.split(".").pop() : "";
	const fence = ext ? "```" + ext : "```";
	const content = `# ${owner}/${repo} — ${filePath}\n\n> Raw: ${rawUrl}\n\n${fence}\n${text}\n\`\`\``;
	return {
		url: url.href,
		title: `${owner}/${repo}: ${filePath}`,
		content,
		error: null,
	};
}

async function extractRepo(
	ctx: FetchContext,
	url: URL,
): Promise<FetchResult | null> {
	const m = url.pathname.match(REPO_RE);
	if (!m) return null;
	const [, owner, repo] = m;
	if (RESERVED_TOP.has(owner.toLowerCase())) return null;
	const fullName = `${owner}/${repo}`;
	const signal = ctx.signal;

	// Prefer gh CLI (uses user's auth → higher rate limit, private repos).
	const ghView = await ghRun(["repo", "view", fullName], signal);
	if (ghView?.trim()) {
		return {
			url: url.href,
			title: fullName,
			content: ghView,
			error: null,
		};
	}

	// Fallback: anonymous REST API (60 req/h).
	const repoData = await fetchJson<GhRepo>(
		ctx,
		`https://api.github.com/repos/${fullName}`,
	);
	if (!repoData) return null;

	const lines: string[] = [`# ${repoData.full_name}`, ""];
	if (repoData.description) lines.push(repoData.description, "");
	lines.push(
		`> ⭐ ${repoData.stargazers_count} · 🍴 ${repoData.forks_count} · 📋 ${repoData.open_issues_count} issues · ${repoData.language || "—"}`,
	);
	if (repoData.license?.spdx_id) lines.push(`> License: ${repoData.license.spdx_id}`);
	if (repoData.topics?.length) lines.push(`> Topics: ${repoData.topics.join(", ")}`);
	if (repoData.homepage) lines.push(`> Homepage: ${repoData.homepage}`);
	lines.push("", "---", "");

	const readme = await ghApi<GhReadme>(
		`repos/${fullName}/readme`,
		signal,
	) ?? await fetchJson<GhReadme>(
		ctx,
		`https://api.github.com/repos/${fullName}/readme`,
	);
	if (readme?.encoding === "base64" && readme.content) {
		try {
			lines.push(Buffer.from(readme.content, "base64").toString("utf-8"));
		} catch {
			lines.push("*(README could not be decoded)*");
		}
	} else {
		lines.push("*(No README found)*");
	}

	return {
		url: url.href,
		title: repoData.full_name,
		content: lines.join("\n"),
		error: null,
	};
}

async function extractIssueOrPR(
	ctx: FetchContext,
	url: URL,
): Promise<FetchResult | null> {
	const isPR = PR_RE.test(url.pathname);
	const m = url.pathname.match(isPR ? PR_RE : ISSUE_RE);
	if (!m) return null;
	const [, owner, repo, numStr] = m;
	const fullName = `${owner}/${repo}`;
	const num = parseInt(numStr, 10);
	const signal = ctx.signal;

	const endpoint = `repos/${fullName}/${isPR ? "pulls" : "issues"}/${num}`;
	const data =
		(await ghApi<GhIssue>(endpoint, signal)) ??
		(await fetchJson<GhIssue>(ctx, `https://api.github.com/${endpoint}`));
	if (!data) return null;

	const lines: string[] = [
		`# ${isPR ? "PR" : "Issue"} #${data.number}: ${data.title}`,
		"",
		`> ${isPR ? "PR" : "Issue"} by ${data.user?.login || "?"} · ${data.state} · ${data.created_at.slice(0, 10)}`,
	];
	if (data.labels?.length) {
		lines.push(`> Labels: ${data.labels.map((l) => l.name).join(", ")}`);
	}
	if (data.assignees?.length) {
		lines.push(`> Assignees: ${data.assignees.map((a) => a.login).join(", ")}`);
	}
	lines.push("", "---", "");
	if (data.body) lines.push(data.body, "");

	// Issue comments endpoint also covers PR conversation comments.
	const commentsEndpoint = `repos/${fullName}/issues/${num}/comments?per_page=20`;
	const comments =
		(await ghApi<GhComment[]>(commentsEndpoint, signal)) ??
		(await fetchJson<GhComment[]>(ctx, `https://api.github.com/${commentsEndpoint}`));
	if (comments && comments.length > 0) {
		lines.push("## Comments", "");
		for (const c of comments) {
			lines.push(`**${c.user?.login || "?"}** (${c.created_at.slice(0, 10)}):`);
			lines.push(c.body, "");
		}
	}

	return {
		url: url.href,
		title: `#${data.number}: ${data.title}`,
		content: lines.join("\n"),
		error: null,
	};
}

// ── Dispatcher ─────────────────────────────────────────────────────────

async function extractGithub(
	ctx: FetchContext,
	url: URL,
): Promise<FetchResult | null> {
	if (BLOB_RE.test(url.pathname)) return extractBlob(ctx, url);
	if (ISSUE_RE.test(url.pathname) || PR_RE.test(url.pathname)) {
		return extractIssueOrPR(ctx, url);
	}
	if (REPO_RE.test(url.pathname)) return extractRepo(ctx, url);
	return null;
}

export const githubExtractor: Extractor = {
	name: "github",
	match: (url) =>
		url.hostname === "github.com" &&
		(BLOB_RE.test(url.pathname) ||
			ISSUE_RE.test(url.pathname) ||
			PR_RE.test(url.pathname) ||
			REPO_RE.test(url.pathname)),
	extract: extractGithub,
};
