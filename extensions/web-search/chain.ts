// chain.ts

import type { Backend, BackendAttempt, SearchResult } from "./backends/types.ts";
import { filterRelevant } from "./validate.ts";
import { braveBackend } from "./backends/brave.ts";
import { opencliBackend } from "./backends/opencli.ts";
import { browserBackend } from "./backends/browser.ts";

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
  registerBackend(opencliBackend);
  registerBackend(browserBackend);
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
  opencli: 6000,
  browser: 10000,
};

const DEFAULT_TOTAL_TIMEOUT_MS = 15000;
const DEFAULT_CHAIN = ["brave", "opencli", "browser"];

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
  opts?: { chain?: string[]; shortCircuit?: boolean; proxy?: string },
): Promise<ChainResult> {
  const cfg = loadConfig({ chain: opts?.chain });
  const attempts: BackendAttempt[] = [];

  const totalCtl = new AbortController();
  const onParentAbort = () => totalCtl.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const totalTimer = setTimeout(
    () => totalCtl.abort(new Error("total timeout")),
    cfg.totalTimeoutMs,
  );

  try {
    for (const name of cfg.chain) {
      if (totalCtl.signal.aborted) break;

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

        attempts.push({
          name,
          status: { kind: "ok", results: filtered },
          elapsedMs,
        });

        if (opts?.shortCircuit) {
          return { kind: "ok", backend: name, results: filtered, attempts };
        }
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

  return { kind: "fail", attempts };
}
