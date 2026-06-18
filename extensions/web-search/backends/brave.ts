// backends/brave.ts

import { createRequire } from "node:module";
import { connect } from "node:net";
import type { Backend, SearchResult } from "./types.ts";
import { getGlobalNpmRoot } from "../../_common/playwright-utils.ts";

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
// Before falling back to this default we probe the port; if unreachable we
// skip proxying instead of waiting 4s for a timeout on every search.
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

/** Quick TCP probe — resolves in ≤200ms. */
function probeTcpFast(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); resolve(false); }, 200);
    sock.once("connect", () => { clearTimeout(t); sock.end(); resolve(true); });
    sock.once("error", () => { clearTimeout(t); resolve(false); });
  });
}

let defaultProxyProbed = false;
let defaultProxyAlive = false;

async function resolveDefaultProxy(): Promise<string | undefined> {
  if (!defaultProxyProbed) {
    try {
      const u = new URL(DEFAULT_PROXY);
      defaultProxyAlive = await probeTcpFast(u.hostname, Number(u.port) || 7890);
    } catch {
      defaultProxyAlive = false;
    }
    defaultProxyProbed = true;
  }
  return defaultProxyAlive ? DEFAULT_PROXY : undefined;
}

// Candidate locations where undici may live when pi loads us via jiti.
// jiti's module resolution starts from the extension dir, which has no
// node_modules; we have to reach into pi's own bundled deps.
// System-wide paths are static; user-home and npm-global are resolved
// dynamically so this works across machines without hardcoding $HOME.
const SYSTEM_UNDICI_CANDIDATES = [
  "undici",
  "/usr/lib/node_modules/undici",
  "/usr/local/lib/node_modules/undici",
];

const SYSTEM_REQUIRE_BASES = [
  "/usr/lib/node_modules/",
  "/usr/local/lib/node_modules/",
];

function homeCandidate(suffix: string): string | null {
  const home = process.env.HOME;
  if (!home) return null;
  return `${home}/${suffix}`;
}

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
  // Phase 1: static system paths + bare module name
  for (const spec of SYSTEM_UNDICI_CANDIDATES) {
    try {
      const u = pickUndici(await import(spec));
      if (u) return u;
    } catch {
      /* try next */
    }
  }

  // Phase 2: dynamic user-home paths (Volta, nvm, etc.)
  const dynamicCandidates: string[] = [];
  const home = process.env.HOME;
  if (home) {
    // Volta
    dynamicCandidates.push(
      `${home}/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/undici`,
    );
  }
  for (const spec of dynamicCandidates) {
    try {
      const u = pickUndici(await import(spec));
      if (u) return u;
    } catch {
      /* try next */
    }
  }

  // Phase 3: npm global root
  const npmRoot = await getGlobalNpmRoot();
  const requireBases = [...SYSTEM_REQUIRE_BASES];
  if (npmRoot) requireBases.unshift(npmRoot + "/");
  // User-home require bases
  if (home) {
    const voltaBase = homeCandidate(".volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/");
    if (voltaBase) requireBases.unshift(voltaBase);
  }

  for (const base of requireBases) {
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

async function getProxyFetch(override?: string): Promise<{
  fetchFn: typeof fetch;
  dispatcher: unknown | undefined;
}> {
  // Precedence: explicit `override` (per-call --proxy or tool param) →
  // env-based getProxyUrl() → DEFAULT_PROXY (with port probe).
  // `override === ""` is an explicit per-call disable, distinct from `undefined`.
  let rawUrl = override !== undefined ? (override || undefined) : getProxyUrl();
  // When falling back to DEFAULT_PROXY, probe first — skip proxy if Clash
  // isn't listening (avoids 4s timeout on machines without a local proxy).
  if (rawUrl === DEFAULT_PROXY) {
    rawUrl = await resolveDefaultProxy();
  }
  const url = rawUrl;
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

  async search(query, signal, opts) {
    const key = process.env.BRAVE_SEARCH_API_KEY;
    if (!key) throw new Error("BRAVE_SEARCH_API_KEY not set");

    const url =
      `https://api.search.brave.com/res/v1/web/search` +
      `?q=${encodeURIComponent(query)}&count=10`;

    const { fetchFn, dispatcher } = await getProxyFetch(opts?.proxy);
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
