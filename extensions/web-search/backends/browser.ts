// backends/browser.ts

import { spawn } from "node:child_process";
import { loadPlaywright, decodeBingUrl } from "../../_common/playwright-utils.ts";
import type { Backend, SearchResult } from "./types.ts";
import { which } from "../../_common/tools/cli-helpers.ts";

// ── CDP utilities ──────────────────────────────────────────────────────

const CDP_BASE = process.env.PI_WEB_SEARCH_CDP_URL || "http://127.0.0.1:9222";

function getHostname(): string {
  try { return new URL(CDP_BASE).hostname; }
  catch { return "127.0.0.1"; }
}

function ensureCdpNoProxy(): void {
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const cur = (process.env[key] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const h of [getHostname(), "127.0.0.1", "localhost"]) {
      if (!cur.includes(h)) cur.push(h);
    }
    process.env[key] = cur.join(",");
  }
}

async function isCdpReachable(signal?: AbortSignal): Promise<boolean> {
  ensureCdpNoProxy();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1000);
  const fwd = () => ctl.abort();
  signal?.addEventListener("abort", fwd, { once: true });
  try {
    const r = await fetch(`${CDP_BASE}/json/version`, { signal: ctl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", fwd);
  }
}

function getCdpUrl(): string {
  return CDP_BASE;
}

type PickedBackend = "harness" | "playwright" | "none";

async function pickAvailable(): Promise<PickedBackend> {
  const forced = process.env.PI_WEB_SEARCH_BROWSER_BACKEND;
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

// ---------- browser-harness path ----------

// We use Bing because:
//   - html.duckduckgo.com/html/ now serves a "select all squares with a duck"
//     CAPTCHA challenge to every fetch, even from a logged-in Chrome session;
//   - search.brave.com also CAPTCHAs anonymous scrapes;
//   - Bing's organic results page is permissive and its markup is stable.
// Bing wraps every result href in `bing.com/ck/a?u=a1<urlsafe-b64>` for click
// tracking; we decode the `u` param to recover the original destination.
const HARNESS_SCRIPT = (query: string) => `
import json, urllib.parse
q = ${JSON.stringify(query)}
u = "https://www.bing.com/search?q=" + urllib.parse.quote(q)
new_tab(u)
wait_for_load()
items = js("""
  (() => {
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
    return Array.from(document.querySelectorAll('li.b_algo')).slice(0, 10).map(el => {
      const a = el.querySelector('h2 a');
      const s = el.querySelector('.b_caption p, p.b_lineclamp4, .b_lineclamp3');
      if (!a) return null;
      return {
        title: (a.textContent || '').trim(),
        url: decodeBingUrl(a.href),
        snippet: s ? (s.textContent || '').trim() : ''
      };
    }).filter(Boolean);
  })()
""")
print("__RESULTS_JSON__" + json.dumps(items))
`;

// Cap stdout at 1 MB — harness output should never exceed this for a
// single search page; larger output signals garbage or a runaway script.
const MAX_STDOUT = 1 * 1024 * 1024;

function runHarness(query: string, signal: AbortSignal): Promise<string> {
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

    proc.stdin.write(HARNESS_SCRIPT(query));
    proc.stdin.end();
  });
}

function parseHarnessOutput(stdout: string): SearchResult[] {
  const idx = stdout.indexOf("__RESULTS_JSON__");
  if (idx < 0) return [];
  const tail = stdout.slice(idx + "__RESULTS_JSON__".length);
  const lineEnd = tail.indexOf("\n");
  const jsonStr = lineEnd >= 0 ? tail.slice(0, lineEnd) : tail;
  try {
    const arr = JSON.parse(jsonStr) as Array<{
      title: string;
      url: string;
      snippet: string;
    }>;
    return arr
      .filter((x) => x && x.title && x.url)
      .map((x) => ({
        title: x.title,
        url: x.url,
        snippet: x.snippet ?? "",
      }));
  } catch {
    return [];
  }
}

async function resolveWsEndpoint(): Promise<string> {
  // playwright's HTTP probe of /json/version appends an extra trailing slash
  // that some Chromium builds reject with 400. Resolve the ws URL ourselves
  // and hand it directly to connectOverCDP.
  ensureCdpNoProxy();
  const r = await fetch(`${getCdpUrl()}/json/version`);
  if (!r.ok) throw new Error(`CDP /json/version returned ${r.status}`);
  const data = (await r.json()) as { webSocketDebuggerUrl?: string };
  if (!data.webSocketDebuggerUrl) throw new Error("no webSocketDebuggerUrl in CDP response");
  return data.webSocketDebuggerUrl;
}

async function runPlaywright(
  query: string,
  signal: AbortSignal,
): Promise<SearchResult[]> {
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
      await page.goto(
        `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
        { waitUntil: "domcontentloaded", timeout: 8000 },
      );
      // Bing wraps each href in /ck/a?u=a1<urlsafe-b64>; decode to recover
      // the real destination URL.
      const results: SearchResult[] = await page.$$eval(
        "li.b_algo",
        (els: Element[]) => {
          const decodeBingUrl = (href: string): string => {
            try {
              const u = new URL(href);
              const enc = u.searchParams.get("u");
              if (enc && enc.startsWith("a1")) {
                const raw = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
                return atob(raw + "===".slice((raw.length + 3) % 4));
              }
            } catch {}
            return href;
          };
          return els.slice(0, 10).map((el) => {
            const a = el.querySelector("h2 a") as HTMLAnchorElement | null;
            const s = el.querySelector(
              ".b_caption p, p.b_lineclamp4, .b_lineclamp3",
            ) as HTMLElement | null;
            if (!a) return null;
            return {
              title: (a.textContent || "").trim(),
              url: decodeBingUrl(a.href),
              snippet: s ? (s.textContent || "").trim() : "",
            };
          }).filter(Boolean) as SearchResult[];
        },
      );
      return results.filter((r) => r && r.title && r.url);
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

export const browserBackend: Backend = {
  name: "browser",

  async isAvailable() {
    return (await pickAvailable()) !== "none";
  },

  async search(query, signal) {
    const chosen = await pickAvailable();
    if (chosen === "harness") {
      const out = await runHarness(query, signal);
      return parseHarnessOutput(out);
    }
    if (chosen === "playwright") {
      return await runPlaywright(query, signal);
    }
    throw new Error("no usable browser backend (need browser-harness or CDP+playwright)");
  },
};
