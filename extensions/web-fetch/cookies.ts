// Cookie jar for the static fetch path, read live from browser-probe.
//
// The static path used to run with no cookies at all, so every login-gated
// page dead-ended in the browser fallback even when a plain request carrying
// the session cookie would have returned the full article.
//
// Nothing is written to disk here. The jar is read from the browser on demand:
// `browser-probe daemon status --json` first (read-only, side-effect free — if
// the daemon is down we stop, because asking for cookies would start Chrome),
// then `browser-probe cookies get --json`. An explicit file (`--cookies`,
// `PI_WF_COOKIES`) still wins when given — a snapshot for tests and offline use.
//
// Cookie records are the CDP shape browser-probe prints (name, domain, path,
// expires in seconds, secure, sameSite).

import { execFile as _execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";

const execFile = promisify(_execFile);

interface Cookie {
	name?: string;
	value?: string;
	domain?: string;
	path?: string;
	/** Seconds since epoch; -1 or absent means a session cookie. */
	expires?: number;
	secure?: boolean;
}

// Parsed file jar, keyed by file + mtime — an explicit snapshot must be picked
// up when it changes without a process restart.
let fileCache: { key: string; cookies: Cookie[] } | null = null;

// Live jar, cached for a short window. The pi extension process serves many
// fetches; asking the browser on every one of them would add two subprocess
// round trips to each. 30s is short enough that a fresh login is picked up
// within one or two fetches.
const LIVE_TTL_MS = 30_000;
let liveCache: { at: number; cookies: Cookie[] } | null = null;

/** Path of an explicit snapshot jar, when one is configured. */
export function cookieFilePath(explicit?: string): string | undefined {
	return explicit ?? process.env.PI_WF_COOKIES ?? undefined;
}

function debug(msg: string): void {
	if (process.env.PI_WF_DEBUG === "1") process.stderr.write(`[pi-wf] cookies: ${msg}\n`);
}

async function run(args: string[], timeout: number): Promise<string> {
	const { stdout } = await execFile("browser-probe", args, {
		timeout,
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout;
}

function loadFileJar(file: string): Cookie[] {
	let key: string;
	try {
		key = `${file}:${statSync(file).mtimeMs}`;
	} catch {
		debug(`${file} not found — no cookies from it`);
		return [];
	}
	if (fileCache?.key === key) return fileCache.cookies;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		fileCache = { key, cookies: Array.isArray(parsed) ? parsed : [] };
	} catch (e) {
		debug(`${file} is not readable JSON — ${(e as Error).message}`);
		fileCache = { key, cookies: [] };
	}
	return fileCache.cookies;
}

/** Read the browser's cookies. Returns [] rather than throwing: a dead daemon,
 *  a missing binary or a slow round trip must never fail the fetch, only drop
 *  us back to anonymous requests. */
async function loadLiveJar(): Promise<Cookie[]> {
	if (liveCache && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.cookies;
	const t0 = Date.now();
	try {
		const status = JSON.parse(await run(["daemon", "status", "--json"], 2000));
		if (status?.status !== "running" || status?.chromeAlive === false) {
			debug("browser-probe daemon is not running — no cookies (not starting it)");
			return [];
		}
		const parsed = JSON.parse(await run(["cookies", "get", "--json"], 5000));
		const cookies = Array.isArray(parsed) ? parsed : [];
		liveCache = { at: Date.now(), cookies };
		debug(`read ${cookies.length} live in ${Date.now() - t0}ms`);
		return cookies;
	} catch (e) {
		debug(`live read failed after ${Date.now() - t0}ms — ${(e as Error).message}`);
		return [];
	}
}

/** RFC 6265 matching, narrowed to what a Cookie header needs: domain (with
 *  subdomain rule), path prefix, secure scheme, expiry. */
function matches(cookie: Cookie, host: string, pathname: string, isHttps: boolean): boolean {
	const domain = (cookie.domain ?? "").replace(/^\./, "").toLowerCase();
	if (!domain) return false;
	if (host !== domain && !host.endsWith(`.${domain}`)) return false;
	if (cookie.secure && !isHttps) return false;
	if (cookie.expires !== undefined && cookie.expires > 0 && cookie.expires * 1000 < Date.now()) {
		return false;
	}
	const cpath = cookie.path || "/";
	return pathname === cpath || pathname.startsWith(cpath.endsWith("/") ? cpath : `${cpath}/`);
}

/**
 * The `Cookie:` header value for `url`, or "" when there is nothing for it.
 * Longest path first, so a specific cookie wins over a site-wide one.
 *
 * Reads all cookies from whichever jar applies and filters here: browser-probe's
 * per-domain filter asks CDP with a URL filter, which returns fewer cookies than
 * the profile actually holds (measured: 1 instead of 17 for www.google.com).
 */
export async function cookieHeaderFor(url: string, explicitPath?: string): Promise<string> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "";
	}
	const explicit = cookieFilePath(explicitPath);
	const jar = explicit ? loadFileJar(explicit) : await loadLiveJar();
	if (!jar.length) return "";

	const host = parsed.hostname.toLowerCase();
	const pathname = parsed.pathname || "/";
	const isHttps = parsed.protocol === "https:";

	const pairs = jar
		.filter((c) => c.name && matches(c, host, pathname, isHttps))
		.sort((a, b) => (b.path?.length ?? 1) - (a.path?.length ?? 1))
		.map((c) => `${c.name}=${c.value ?? ""}`);

	if (!pairs.length) return "";
	debug(`${pairs.length} matched for ${host} (${explicit ?? "live browser"})`);
	return pairs.join("; ");
}
