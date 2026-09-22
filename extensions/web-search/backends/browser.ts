// backends/browser.ts

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPlaywright } from "../../_common/playwright-utils.ts";
import type { Backend, SearchResult } from "./types.ts";
import { which } from "../../_common/tools/cli-helpers.ts";

// ── Which browser ──────────────────────────────────────────────────────
//
// Default target is the browser browser-probe's daemon already owns, not one
// we guess at. `~/.browser-probe/active` is browser-probe's own session
// pointer (`default` is an alias for it), and `sessions/<name>/daemon.json` is
// the file browser-probe itself reads to find the browser's port
// (src/cli/doctor.ts, src/cli/session.ts). The port is ephemeral and changes
// on every browser restart, so reading it beats configuring it.
//
// Order: `PI_WEB_SEARCH_CDP_URL` → live daemon browser → `127.0.0.1:9222`.
// `PI_WEB_SEARCH_CDP_DISCOVER=0` skips the discovery step. When none of those
// is reachable the caller falls back to browser-harness, as before.

const DEFAULT_CDP = "http://127.0.0.1:9222";
const PROBE_TIMEOUT_MS = 1000;

let cdpBase: { url: string; source: string } | null = null;

function browserProbeHome(): string {
  return process.env.PI_WEB_SEARCH_BROWSER_PROBE_HOME || join(homedir(), ".browser-probe");
}

/** The browser-probe daemon's current browser, or null when unknowable. */
function daemonCdpCandidate(): { url: string; source: string } | null {
  const home = browserProbeHome();
  try {
    const name = readFileSync(join(home, "active"), "utf-8").trim();
    if (!name) return null;
    const info = JSON.parse(
      readFileSync(join(home, "sessions", name, "daemon.json"), "utf-8"),
    ) as { chrome?: { port?: number } | null };
    const port = info?.chrome?.port;
    if (typeof port !== "number" || !Number.isFinite(port)) return null;
    return { url: `http://127.0.0.1:${port}`, source: `browser-probe session "${name}"` };
  } catch {
    return null;
  }
}

function ensureNoProxyFor(base: string): void {
  let host = "127.0.0.1";
  try { host = new URL(base).hostname; } catch { /* keep the default */ }
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const cur = (process.env[key] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const h of [host, "127.0.0.1", "localhost"]) {
      if (!cur.includes(h)) cur.push(h);
    }
    process.env[key] = cur.join(",");
  }
}

async function probeCdp(base: string, signal?: AbortSignal): Promise<boolean> {
  ensureNoProxyFor(base);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  const fwd = () => ctl.abort();
  signal?.addEventListener("abort", fwd, { once: true });
  try {
    const r = await fetch(`${base}/json/version`, { signal: ctl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", fwd);
  }
}

/**
 * CDP endpoint to drive, resolved once per process. `force` re-reads
 * browser-probe's state — its browser port changes on restart, so a cached
 * endpoint goes stale and the caller re-resolves after a connect failure.
 */
export async function resolveCdpBase(
  force = false,
): Promise<{ url: string; source: string }> {
  if (cdpBase && !force) return cdpBase;

  const explicit = process.env.PI_WEB_SEARCH_CDP_URL?.trim();
  if (explicit) {
    cdpBase = { url: explicit, source: "PI_WEB_SEARCH_CDP_URL" };
    return cdpBase;
  }

  if (process.env.PI_WEB_SEARCH_CDP_DISCOVER !== "0") {
    const candidate = daemonCdpCandidate();
    if (candidate && (await probeCdp(candidate.url))) {
      cdpBase = candidate;
      return cdpBase;
    }
  }

  cdpBase = { url: DEFAULT_CDP, source: "default 9222" };
  return cdpBase;
}

/**
 * Endpoint to drive: the cached one while it still answers, otherwise a fresh
 * read of browser-probe's state. Its browser gets a new port on every restart,
 * so a cached port going dead is expected rather than exceptional.
 */
async function liveCdpBase(signal?: AbortSignal): Promise<string | null> {
  const cached = await resolveCdpBase();
  if (await probeCdp(cached.url, signal)) return cached.url;
  const fresh = await resolveCdpBase(true);
  return (await probeCdp(fresh.url, signal)) ? fresh.url : null;
}

async function isCdpReachable(signal?: AbortSignal): Promise<boolean> {
  return (await liveCdpBase(signal)) !== null;
}

type PickedBackend = "harness" | "playwright" | "none";

async function pickAvailable(): Promise<PickedBackend> {
  const forced = process.env.PI_WEB_SEARCH_BROWSER_PROBE_BACKEND ?? process.env.PI_WEB_SEARCH_BROWSER_BACKEND;
  if (forced === "harness") {
    return (await which("browser-harness")) ? "harness" : "none";
  }
  if (forced === "playwright") {
    return (await isCdpReachable()) && (await loadPlaywright()) !== null
      ? "playwright"
      : "none";
  }
  // auto: prefer playwright when a CDP endpoint is reachable (cheaper,
  // reuses your running browser); fall back to harness; else none.
  if (await isCdpReachable()) {
    if ((await loadPlaywright()) !== null) return "playwright";
  }
  if (await which("browser-harness")) return "harness";
  return "none";
}

// ── Engines ────────────────────────────────────────────────────────────
//
// Google first, Bing second — the same order the `browser-probe search`
// surface uses, so `web_search --chain browser-probe` and a direct
// `browser_probe ["search", ...]` call see the same SERP instead of silently
// diverging (this backend used to hardcode Bing).
//
// Bing stays as the fallback: html.duckduckgo.com/html/ serves a CAPTCHA to
// every fetch, search.brave.com CAPTCHAs anonymous scrapes, and Google can
// serve a consent interstitial or reject an automated navigation. Bing's
// organic page is permissive and its markup is stable.
//
// Forcing one engine (no fallback) is `PI_WEB_SEARCH_ENGINE=google|bing`.
//
// Both engines need a URL decoder: Bing wraps targets in
// `bing.com/ck/a?u=a1<urlsafe-b64>` and Google sends some results through
// `/url?q=<target>`.

type EngineName = "google" | "bing";

interface Engine {
  /** Selector whose presence means the results DOM has rendered. */
  waitFor: string;
  url: (query: string) => string;
  /** Page-context IIFE returning `{ title, url, snippet }[]`. */
  scrape: string;
}

const GOOGLE_SCRAPE = `(() => {
  const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim();
  const hostOf = (href) => { try { return new URL(href).hostname; } catch { return ''; } };
  const isGoogleHost = (h) => h.split('.').includes('google');
  const hostFromCite = (cite) => {
    const t = (cite || '').trim();
    const i = t.indexOf('://');
    const rest = i >= 0 ? t.slice(i + 3) : t;
    const h = rest.split('/')[0].split(' ')[0];
    return h.includes('.') && !isGoogleHost(h) ? h : '';
  };
  // Google hands out direct links for some results and opaque /goto tokens for
  // others; when the destination is unrecoverable, fall back to the displayed
  // citation host so the caller still gets a usable URL.
  const resolve = (anchor, container) => {
    const href = anchor.href || '';
    try {
      const p = new URL(href);
      const dest = p.searchParams.get('q') || p.searchParams.get('url');
      if (dest && dest.indexOf('http') === 0) return dest;
    } catch {}
    if (href && !isGoogleHost(hostOf(href))) return href;
    const cite = container && container.querySelector('cite');
    const h = hostFromCite(cite ? cite.textContent : '');
    return h ? 'https://' + h + '/' : href;
  };
  const items = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll('a[href]')) {
    const h3 = anchor.querySelector('h3');
    if (!h3) continue;
    const container = anchor.closest('.MjjYud, .g, [data-snhf]') || (anchor.parentElement && anchor.parentElement.parentElement);
    const url = resolve(anchor, container);
    if (!url || url.indexOf('http') !== 0 || seen.has(url)) continue;
    seen.add(url);
    const sn = container && container.querySelector('.VwiC3b, .IsZvec, [data-sncf]');
    items.push({
      title: norm(h3.textContent).slice(0, 200),
      url: url,
      snippet: norm(sn && sn.textContent).slice(0, 320)
    });
    if (items.length >= 12) break;
  }
  if (items.length === 0) {
    const body = document.body ? (document.body.innerText || '') : '';
    if (/unusual traffic|automated queries|我们的系统检测到/i.test(body)) return { items: [], blocked: 'unusual-traffic page' };
    if (/before you continue|consent|同意/i.test(body)) return { items: [], blocked: 'consent page' };
  }
  return { items: items, blocked: '' };
})()`;

const BING_SCRAPE = `(() => {
  const decodeBingUrl = (href) => {
    try {
      const u = new URL(href);
      const enc = u.searchParams.get('u');
      if (enc && enc.startsWith('a1')) {
        const raw = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        return atob(raw + '==='.slice((raw.length + 3) % 4));
      }
    } catch {}
    return href;
  };
  const items = Array.from(document.querySelectorAll('li.b_algo')).slice(0, 12).map(el => {
    const a = el.querySelector('h2 a');
    const s = el.querySelector('.b_caption p, p.b_lineclamp4, .b_lineclamp3');
    if (!a) return null;
    return {
      title: (a.textContent || '').trim(),
      url: decodeBingUrl(a.href),
      snippet: s ? (s.textContent || '').trim() : ''
    };
  }).filter(Boolean);
  return { items: items, blocked: '' };
})()`;

const ENGINES: Record<EngineName, Engine> = {
  google: {
    waitFor: "div#search a h3, div#rso a h3",
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    scrape: GOOGLE_SCRAPE,
  },
  bing: {
    waitFor: "li.b_algo",
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    scrape: BING_SCRAPE,
  },
};

const DEFAULT_ENGINE_ORDER: EngineName[] = ["google", "bing"];

function isEngineName(v: string): v is EngineName {
  return v === "google" || v === "bing";
}

/** Engines to try, in order. One entry when PI_WEB_SEARCH_ENGINE pins one. */
export function getEngineOrder(): EngineName[] {
  const raw = (process.env.PI_WEB_SEARCH_ENGINE ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_ENGINE_ORDER;
  if (isEngineName(raw)) return [raw];
  // eslint-disable-next-line no-console
  console.warn(`[web-search] unknown PI_WEB_SEARCH_ENGINE "${raw}" ignored (known: google, bing)`);
  return DEFAULT_ENGINE_ORDER;
}

// Per-engine navigation budget. Two engines must still fit inside the
// backend's own 15s timeout (DEFAULT_TIMEOUTS["browser-probe"]).
const NAV_TIMEOUT_MS = 6000;
const WAIT_FOR_RESULTS_MS = 3000;

// ── browser-harness path ───────────────────────────────────────────────

function harnessScript(query: string, engine: Engine): string {
  return `
import json
u = ${JSON.stringify(engine.url(query))}
new_tab(u)
wait_for_load()
items = js("""
${engine.scrape}
""")
print("__RESULTS_JSON__" + json.dumps(items))
`;
}

// Cap stdout at 1 MB — harness output should never exceed this for a
// single search page; larger output signals garbage or a runaway script.
const MAX_STDOUT = 1 * 1024 * 1024;

function runHarness(query: string, signal: AbortSignal, engine: Engine): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("browser-harness", [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    proc.stdout.on("data", (b: Buffer) => {
      if (overflow) return;
      if (stdout.length + b.length > MAX_STDOUT) {
        overflow = true;
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 500).unref();
        return;
      }
      stdout += b.toString();
    });
    proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()));

    const onAbort = () => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 500).unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    proc.once("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    proc.once("exit", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return reject(new Error("aborted"));
      if (overflow) return reject(new Error("harness output exceeded 1 MB limit"));
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `harness exit ${code}`));
      }
      resolve(stdout);
    });

    proc.stdin.write(harnessScript(query, engine));
    proc.stdin.end();
  });
}

interface ScrapeResult {
  items: SearchResult[];
  /** Non-empty when the page was a bot wall rather than a SERP. */
  blocked: string;
}

function normalizeScraped(raw: unknown): ScrapeResult {
  const obj = raw as { items?: unknown; blocked?: unknown } | null;
  const arr = Array.isArray(obj?.items) ? obj!.items : [];
  const items = (arr as Array<{ title?: string; url?: string; snippet?: string }>)
    .filter((x) => x && x.title && x.url)
    .map((x) => ({
      title: String(x.title),
      url: String(x.url),
      snippet: x.snippet ?? "",
    }));
  return { items, blocked: typeof obj?.blocked === "string" ? obj.blocked : "" };
}

function parseHarnessOutput(stdout: string): ScrapeResult {
  const idx = stdout.indexOf("__RESULTS_JSON__");
  if (idx < 0) return { items: [], blocked: "" };
  const tail = stdout.slice(idx + "__RESULTS_JSON__".length);
  const lineEnd = tail.indexOf("\n");
  const jsonStr = lineEnd >= 0 ? tail.slice(0, lineEnd) : tail;
  try {
    return normalizeScraped(JSON.parse(jsonStr));
  } catch {
    return { items: [], blocked: "" };
  }
}

async function resolveWsEndpoint(): Promise<string> {
  // playwright's HTTP probe of /json/version appends an extra trailing slash
  // that some Chromium builds reject with 400. Resolve the ws URL ourselves
  // and hand it directly to connectOverCDP.
  const base = await liveCdpBase();
  if (!base) throw new Error("no reachable CDP endpoint (browser-probe browser not running)");
  ensureNoProxyFor(base);
  const r = await fetch(`${base}/json/version`);
  if (!r.ok) throw new Error(`CDP /json/version returned ${r.status}`);
  const data = (await r.json()) as { webSocketDebuggerUrl?: string };
  if (!data.webSocketDebuggerUrl) throw new Error("no webSocketDebuggerUrl in CDP response");
  return data.webSocketDebuggerUrl;
}

async function runPlaywright(
  query: string,
  signal: AbortSignal,
  engine: Engine,
): Promise<ScrapeResult> {
  const pw = await loadPlaywright();
  if (!pw) throw new Error("playwright not resolvable from any known path");

  const wsEndpoint = await resolveWsEndpoint();
  const browser = await pw.chromium.connectOverCDP(wsEndpoint);
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    const onAbort = () => page.close().catch(() => undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await page.goto(engine.url(query), {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      // Results render after domcontentloaded; a miss here is not fatal —
      // the engine returns [] and the caller falls through to the next one.
      await page.waitForSelector(engine.waitFor, { timeout: WAIT_FOR_RESULTS_MS })
        .catch(() => undefined);
      return normalizeScraped(await page.evaluate(engine.scrape));
    } finally {
      signal.removeEventListener("abort", onAbort);
      await page.close().catch(() => undefined);
    }
  } finally {
    // Important: do NOT close the user's running browser. Only detach.
    await browser.close().catch(() => undefined);
  }
}

// ---------- Backend ----------

export const browserProbeBackend: Backend = {
  name: "browser-probe",

  async isAvailable() {
    return (await pickAvailable()) !== "none";
  },

  async search(query, signal) {
    const chosen = await pickAvailable();
    if (chosen === "none") {
      throw new Error("no usable browser backend (need browser-harness or CDP+playwright)");
    }

    const failures: string[] = [];
    for (const name of getEngineOrder()) {
      try {
        const { items, blocked } =
          chosen === "harness"
            ? parseHarnessOutput(await runHarness(query, signal, ENGINES[name]))
            : await runPlaywright(query, signal, ENGINES[name]);
        if (items.length > 0) return items;
        failures.push(blocked ? `${name}: blocked (${blocked})` : `${name}: 0 results`);
      } catch (err) {
        if (signal.aborted) throw err;
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`no engine returned results (${failures.join("; ")})`);
  },
};
