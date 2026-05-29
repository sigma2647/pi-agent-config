// backends/brave.ts

import { createRequire } from "node:module";
import type { Backend, SearchResult } from "./types.ts";

type BraveResponse = {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
};

// Cached so we only build the ProxyAgent once per process. Two routes:
//   - external undici (works inside pi which bundles undici, or with a local
//     install). When taking this route we MUST also use that same undici's
//     `fetch` — Node's built-in `fetch` rejects dispatcher objects coming from
//     a different undici instance with UND_ERR_INVALID_ARG.
//   - native fetch + NODE_USE_ENV_PROXY=1 (Node ≥ 24): no dispatcher needed
type Cached = {
  url: string;
  agent: unknown | null;
  fetchFn: typeof fetch | null;
};
let cachedDispatcher: Cached | null = null;

// Default proxy assumed available on the local box (Clash/V2Ray on 7890).
// Set PI_WEB_SEARCH_PROXY="" (empty string) to explicitly disable proxying.
const DEFAULT_PROXY = "http://127.0.0.1:7890";

function getProxyUrl(): string | undefined {
  // Explicit empty string anywhere → disable proxy
  const explicit = [
    process.env.PI_WEB_SEARCH_PROXY,
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ];
  for (const v of explicit) {
    if (v === undefined) continue;
    return v === "" ? undefined : v;
  }
  return DEFAULT_PROXY;
}

// Candidate locations where undici may live when pi loads us via jiti.
// jiti's module resolution starts from the extension dir, which has no
// node_modules; we have to reach into pi's own bundled deps.
const UNDICI_CANDIDATES = [
  "undici",
  "/usr/lib/node_modules/undici",
  "/usr/local/lib/node_modules/undici",
  "/home/lawrence/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/undici",
];

const REQUIRE_BASES = [
  "/home/lawrence/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/",
  "/usr/lib/node_modules/",
  "/usr/local/lib/node_modules/",
];

type UndiciExports = {
  ProxyAgent: new (url: string) => unknown;
  fetch: typeof fetch;
};

function pickUndici(m: any): UndiciExports | null {
  const root = m?.ProxyAgent ? m : m?.default;
  if (!root) return null;
  if (typeof root.ProxyAgent === "function" && typeof root.fetch === "function") {
    return { ProxyAgent: root.ProxyAgent, fetch: root.fetch };
  }
  return null;
}

async function loadUndici(): Promise<UndiciExports | null> {
  for (const spec of UNDICI_CANDIDATES) {
    try {
      const u = pickUndici(await import(spec));
      if (u) return u;
    } catch {
      /* try next */
    }
  }
  for (const base of REQUIRE_BASES) {
    try {
      const req = createRequire(base);
      const resolved = req.resolve("undici");
      const u = pickUndici(await import(resolved));
      if (u) return u;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function getProxyFetch(): Promise<{
  fetchFn: typeof fetch;
  dispatcher: unknown | undefined;
}> {
  const url = getProxyUrl();
  if (!url) return { fetchFn: fetch, dispatcher: undefined };
  if (cachedDispatcher && cachedDispatcher.url === url) {
    return {
      fetchFn: cachedDispatcher.fetchFn ?? fetch,
      dispatcher: cachedDispatcher.agent ?? undefined,
    };
  }
  const u = await loadUndici();
  if (u) {
    const agent = new u.ProxyAgent(url);
    cachedDispatcher = { url, agent, fetchFn: u.fetch };
    return { fetchFn: u.fetch, dispatcher: agent };
  }
  // No external undici → defer to Node's native fetch with NODE_USE_ENV_PROXY=1
  cachedDispatcher = { url, agent: null, fetchFn: null };
  return { fetchFn: fetch, dispatcher: undefined };
}

export const braveBackend: Backend = {
  name: "brave",

  async isAvailable() {
    return !!process.env.BRAVE_SEARCH_API_KEY;
  },

  async search(query, signal) {
    const key = process.env.BRAVE_SEARCH_API_KEY;
    if (!key) throw new Error("BRAVE_SEARCH_API_KEY not set");

    const url =
      `https://api.search.brave.com/res/v1/web/search` +
      `?q=${encodeURIComponent(query)}&count=10`;

    const { fetchFn, dispatcher } = await getProxyFetch();
    const init: RequestInit & { dispatcher?: unknown } = {
      signal,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": key,
      },
    };
    if (dispatcher) init.dispatcher = dispatcher;

    const res = await fetchFn(url, init);

    if (!res.ok) {
      throw new Error(`brave HTTP ${res.status}`);
    }

    const data = (await res.json()) as BraveResponse;
    const raw = data.web?.results ?? [];
    const results: SearchResult[] = raw
      .filter((x) => x.title && x.url)
      .map((x) => ({
        title: x.title ?? "",
        url: x.url ?? "",
        snippet: x.description ?? "",
      }));

    return results;
  },
};
