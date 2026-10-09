// chain.ts

import type { Backend, BackendAttempt, SearchResult } from "./backends/types.ts";
import { filterRelevant, isStrongResultSet } from "./validate.ts";
import { braveBackend } from "./backends/brave.ts";
import { exaBackend } from "./backends/exa.ts";
import { browserProbeBackend } from "./backends/browser.ts";

const REGISTRY = new Map<string, Backend>();

export function registerBackend(b: Backend): void {
  REGISTRY.set(b.name, b);
}

// The built-in chain. Every entry point (dev.ts CLI, index.ts pi loader,
// tools/doctor.ts) must call this before loadConfig()/runChain(), otherwise the
// REGISTRY is empty and the chain reports every backend as "unknown". Idempotent
// — re-registering the same name just overwrites.
export function registerDefaultBackends(): void {
  registerBackend(braveBackend);
  registerBackend(exaBackend);
  registerBackend(browserProbeBackend);
}

export function listBackends(): string[] {
  return [...REGISTRY.keys()];
}

export type ChainConfig = {
  chain: string[];
  perBackendTimeoutMs: Record<string, number>;
  totalTimeoutMs: number;
};

const DEFAULT_TIMEOUTS: Record<string, number> = {
  brave: 4000,
  exa: 5000,
  // browser.ts walks 2 inner engines (google → bing), each with its own
  // 6.5s budget: 2 × 6.5s = 13s stays inside the backend's own 21s timeout,
  // which keeps its headroom for browser startup on a cold session.
  "browser-probe": 21000,
};

// brave (4s) + browser-probe (21s) must fit inside this.
const DEFAULT_TOTAL_TIMEOUT_MS = 30000;
// Opt-in backends (exa) are registered but stay out of the default chain;
// enable them with PI_WEB_SEARCH_CHAIN or --chain.
const DEFAULT_CHAIN = ["brave", "browser-probe"];

// Single source of truth for the one user-facing chain knob. Both entry points
// (index.ts tool param, dev.ts --fast flag) describe it from here and pass the
// resulting boolean straight into runChain — they do NOT invent intermediate
// vocabulary ("instant"/"full") or re-translate it to behaviour. Change the
// meaning here and the signature below; the entry points just pass through.
export const FAST_OPTION_DESC =
  "Query only the first backend in the chain (fail-fast, lowest latency); " +
  "skip the slower browser-probe fallback even if the first returns nothing or " +
  "only a weak set.";

export function loadConfig(override?: {
  chain?: string[];
  totalTimeoutMs?: number;
}): ChainConfig {
  const envChain = process.env.PI_WEB_SEARCH_CHAIN
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const rawChain = override?.chain ?? envChain ?? DEFAULT_CHAIN;
  const knownChain = rawChain.filter((name) => {
    if (REGISTRY.has(name)) return true;
    // eslint-disable-next-line no-console
    console.warn(`[web-search] unknown backend "${name}" ignored`);
    return false;
  });

  const perBackendTimeoutMs: Record<string, number> = { ...DEFAULT_TIMEOUTS };
  for (const name of REGISTRY.keys()) {
    const envKey = `PI_WEB_SEARCH_TIMEOUT_${name.toUpperCase()}`;
    const raw = process.env[envKey];
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) perBackendTimeoutMs[name] = n;
    }
  }

  const totalEnv = Number(process.env.PI_WEB_SEARCH_TOTAL_TIMEOUT);
  const totalTimeoutMs =
    override?.totalTimeoutMs ??
    (Number.isFinite(totalEnv) && totalEnv > 0
      ? totalEnv
      : DEFAULT_TOTAL_TIMEOUT_MS);

  return { chain: knownChain, perBackendTimeoutMs, totalTimeoutMs };
}

export type ChainResult =
  | { kind: "ok"; backend: string; results: SearchResult[]; attempts: BackendAttempt[] }
  | { kind: "fail"; attempts: BackendAttempt[] };

export async function runChain(
  query: string,
  parentSignal: AbortSignal,
  opts?: { chain?: string[]; fast?: boolean; proxy?: string },
): Promise<ChainResult> {
  const cfg = loadConfig({ chain: opts?.chain });
  // fast = primary backend only: slice the chain to its first entry so the
  // existing stop-at-first-strong loop naturally fails fast without ever
  // reaching the slow fallbacks, and a weak set cannot escalate. No
  // special-casing inside the loop.
  const effectiveChain = opts?.fast ? cfg.chain.slice(0, 1) : cfg.chain;
  const attempts: BackendAttempt[] = [];
  // The latest non-empty-but-weak set, kept as a last resort: a chain that
  // never produces a strong set (the fallback is down, everything matched thinly)
  // should still answer with the best it saw rather than report a failure.
  let weakFallback: { backend: string; results: SearchResult[] } | null = null;

  const totalCtl = new AbortController();
  const onParentAbort = () => totalCtl.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const totalTimer = setTimeout(
    () => totalCtl.abort(new Error("total timeout")),
    cfg.totalTimeoutMs,
  );

  try {
    for (let i = 0; i < effectiveChain.length; i++) {
      if (totalCtl.signal.aborted) break;
      const name = effectiveChain[i];

      const backend = REGISTRY.get(name);
      if (!backend) continue; // already warned in loadConfig

      const t0 = Date.now();

      const available = await backend.isAvailable().catch(() => false);
      if (!available) {
        attempts.push({
          name,
          status: { kind: "skipped", reason: "not available" },
          elapsedMs: Date.now() - t0,
        });
        continue;
      }

      const perTimeoutMs = cfg.perBackendTimeoutMs[name] ?? 8000;
      const perCtl = new AbortController();
      const fwd = () => perCtl.abort(totalCtl.signal.reason);
      totalCtl.signal.addEventListener("abort", fwd, { once: true });
      const perTimer = setTimeout(
        () => perCtl.abort(new Error(`${name} timeout`)),
        perTimeoutMs,
      );

      try {
        const raw = await backend.search(query, perCtl.signal, { proxy: opts?.proxy });
        const filtered = filterRelevant(query, raw);
        const elapsedMs = Date.now() - t0;

        if (filtered.length === 0) {
          attempts.push({
            name,
            status: {
              kind: "empty",
              reason: `0 of ${raw.length} results matched query keywords`,
            },
            elapsedMs,
          });
          continue;
        }

        // Weak-but-non-empty escalates instead of stopping. Escalation only:
        // the weak set is discarded, never merged with the next backend's —
        // no fan-out, no RRF (docs/browser-automation.md, "Fallback chains").
        if (!isStrongResultSet(query, filtered)) {
          const last = i === effectiveChain.length - 1;
          attempts.push({
            name,
            status: {
              kind: "weak",
              resultCount: filtered.length,
              reason: `${filtered.length} results, below the strength bar — ${
                last ? "nothing left to escalate to" : "escalating"
              }`,
            },
            elapsedMs,
          });
          weakFallback = { backend: name, results: filtered };
          continue;
        }

        attempts.push({
          name,
          status: { kind: "ok", resultCount: filtered.length },
          elapsedMs,
        });

        // Stop at the first backend returning a *strong* set. The chain is
        // brave (primary) → browser-probe (fallback), not peer engines —
        // fanning out + merging would add latency + noise for little breadth.
        return { kind: "ok", backend: name, results: filtered, attempts };
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : String(err);
        attempts.push({
          name,
          status: { kind: "failed", reason },
          elapsedMs: Date.now() - t0,
        });
      } finally {
        clearTimeout(perTimer);
        totalCtl.signal.removeEventListener("abort", fwd);
      }
    }
  } finally {
    clearTimeout(totalTimer);
    parentSignal.removeEventListener("abort", onParentAbort);
  }

  // Nothing strong anywhere. A weak set we did see beats reporting a failure;
  // the attempt still says `weak`, so the caller can tell the difference.
  if (weakFallback) {
    return {
      kind: "ok",
      backend: weakFallback.backend,
      results: weakFallback.results,
      attempts,
    };
  }

  return { kind: "fail", attempts };
}
