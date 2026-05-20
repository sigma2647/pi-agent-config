// backends/browser.ts

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { Backend, SearchResult } from "./types";

async function which(cmd: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const p = spawn("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    p.once("exit", (code) => resolve(code === 0));
    p.once("error", () => resolve(false));
  });
}

function getCdpUrl(): string {
  return process.env.PI_WEB_SEARCH_CDP_URL || "http://127.0.0.1:9222";
}

async function isCdpReachable(signal?: AbortSignal): Promise<boolean> {
  const base = getCdpUrl();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1000);
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

type PickedBackend = "harness" | "playwright" | "none";

async function pickAvailable(): Promise<PickedBackend> {
  const forced = process.env.PI_WEB_SEARCH_BROWSER_BACKEND;
  if (forced === "harness") {
    return (await which("browser-harness")) ? "harness" : "none";
  }
  if (forced === "playwright") {
    return (await isCdpReachable()) && (await tryImportPlaywright()) !== null
      ? "playwright"
      : "none";
  }
  // auto: prefer playwright when a CDP endpoint is reachable (cheaper,
  // reuses your running browser); fall back to harness; else none.
  if (await isCdpReachable()) {
    if ((await tryImportPlaywright()) !== null) return "playwright";
  }
  if (await which("browser-harness")) return "harness";
  return "none";
}

// ---------- browser-harness path ----------

const HARNESS_SCRIPT = (query: string) => `
import json, urllib.parse
q = ${JSON.stringify(query)}
u = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(q)
new_tab(u)
wait_for_load()
items = js("""
  Array.from(document.querySelectorAll('div.result, div.web-result')).slice(0, 10).map(el => {
    const a = el.querySelector('a.result__a, a.result-title');
    const s = el.querySelector('.result__snippet, .result-snippet');
    return a ? { title: a.innerText.trim(), url: a.href, snippet: s ? s.innerText.trim() : '' } : null;
  }).filter(Boolean)
""")
print("__RESULTS_JSON__" + json.dumps(items))
`;

function runHarness(query: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("browser-harness", [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
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

// ---------- playwright (connect-over-CDP) path ----------

const PLAYWRIGHT_CANDIDATES = [
  "playwright",
  "playwright-core",
  "/usr/lib/node_modules/playwright",
  "/usr/lib/node_modules/playwright-core",
  "/usr/local/lib/node_modules/playwright",
  "/usr/local/lib/node_modules/playwright-core",
];

let cachedPlaywright: { chromium: any } | null | undefined;

function extractChromium(m: any): any | null {
  // Playwright is published as CJS; dynamic ESM import wraps named exports
  // both at the top level and under `default`. Probe both.
  return m?.chromium ?? m?.default?.chromium ?? null;
}

async function tryImportPlaywright(): Promise<{ chromium: any } | null> {
  if (cachedPlaywright !== undefined) return cachedPlaywright;
  for (const spec of PLAYWRIGHT_CANDIDATES) {
    try {
      const m: any = await import(spec);
      const chromium = extractChromium(m);
      if (chromium) {
        cachedPlaywright = { chromium };
        return cachedPlaywright;
      }
    } catch {
      /* try next */
    }
  }
  // Last resort: createRequire pointed at well-known locations.
  for (const base of [
    "/usr/lib/node_modules/",
    "/usr/local/lib/node_modules/",
  ]) {
    try {
      const req = createRequire(base);
      const resolved = req.resolve("playwright");
      const m: any = await import(resolved);
      const chromium = extractChromium(m);
      if (chromium) {
        cachedPlaywright = { chromium };
        return cachedPlaywright;
      }
    } catch {
      /* try next */
    }
  }
  cachedPlaywright = null;
  return null;
}

async function resolveWsEndpoint(): Promise<string> {
  // playwright's HTTP probe of /json/version appends an extra trailing slash
  // that some Chromium builds reject with 400. Resolve the ws URL ourselves
  // and hand it directly to connectOverCDP.
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
  const pw = await tryImportPlaywright();
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
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        { waitUntil: "domcontentloaded", timeout: 8000 },
      );
      const results: SearchResult[] = await page.$$eval(
        "div.result, div.web-result",
        (els: Element[]) =>
          els.slice(0, 10).map((el) => {
            const a = el.querySelector(
              "a.result__a, a.result-title",
            ) as HTMLAnchorElement | null;
            const s = el.querySelector(
              ".result__snippet, .result-snippet",
            ) as HTMLElement | null;
            if (!a) return null;
            return {
              title: (a.innerText || "").trim(),
              url: a.href,
              snippet: s ? (s.innerText || "").trim() : "",
            };
          }).filter(Boolean) as SearchResult[],
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
