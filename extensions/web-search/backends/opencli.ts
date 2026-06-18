// backends/opencli.ts

import { spawn } from "node:child_process";
import type { Backend, SearchResult } from "./types.ts";
import { which } from "../../_common/tools/cli-helpers.ts";

// Search adapters to try in order. Each runs `opencli <adapter> search <query> -f json`.
// Override via PI_OPENCLI_SEARCH_ADAPTERS env var (comma-separated).
const DEFAULT_ADAPTERS = ["google", "duckduckgo", "brave"];

// Cap stdout at 1 MB — opencli output should never exceed this for a single
// search page; larger output is a sign of garbage injection or a runaway adapter.
const MAX_STDOUT = 1 * 1024 * 1024;

function getAdapters(): string[] {
  const raw = process.env.PI_OPENCLI_SEARCH_ADAPTERS;
  if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_ADAPTERS;
}

function runAdapter(
  adapter: string,
  query: string,
  signal: AbortSignal,
  opts?: { proxy?: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const spawnEnv = opts?.proxy
      ? { ...process.env, HTTPS_PROXY: opts.proxy }
      : undefined;
    const proc = spawn(
      "opencli",
      [adapter, "search", query, "-f", "json"],
      { stdio: ["ignore", "pipe", "pipe"], env: spawnEnv },
    );

    let stdout = "";
    let stderr = "";
    let overflow = false;
    proc.stdout.on("data", (b: Buffer) => {
      if (overflow) return;
      if (stdout.length + b.length > MAX_STDOUT) {
        overflow = true;
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 250).unref();
        return;
      }
      stdout += b.toString();
    });
    proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()));

    const onAbort = () => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 250).unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    proc.once("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    proc.once("exit", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (overflow) {
        reject(new Error("opencli output exceeded 1 MB limit"));
        return;
      }
      if (code !== 0) {
        const msg = stderr.trim() || `opencli ${adapter} exit ${code}`;
        reject(new Error(msg));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseResults(raw: string): SearchResult[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("opencli output is not JSON");
  }

  // opencli result envelope varies between sites. Walk the tree, find arrays
  // of objects, try mapping each to SearchResult. First non-empty match wins.
  const candidates = collectArrays(data);
  for (const arr of candidates) {
    const mapped = arr
      .map(toSearchResult)
      .filter((r): r is SearchResult => r !== null);
    if (mapped.length > 0) return mapped;
  }
  return [];
}

function collectArrays(node: unknown, out: unknown[][] = []): unknown[][] {
  if (Array.isArray(node)) out.push(node);
  else if (node && typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) {
      collectArrays(v, out);
    }
  }
  return out;
}

function toSearchResult(item: unknown): SearchResult | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const title =
    pickString(o, ["title", "name", "heading"]) ?? "";
  const url =
    pickString(o, ["url", "link", "href"]) ?? "";
  const snippet =
    pickString(o, ["snippet", "description", "text", "summary"]) ?? "";
  if (!title || !url) return null;
  return { title, url, snippet };
}

function pickString(
  o: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export const opencliBackend: Backend = {
  name: "opencli",

  async isAvailable() {
    if (!(await which("opencli"))) return false;
    // Do not run `opencli doctor` here — daemon-offline still leaves the CLI
    // usable; the actual availability is decided by the search() call.
    return true;
  },

  async search(query, signal, opts) {
    const adapters = getAdapters();
    const errors: string[] = [];
    for (const a of adapters) {
      if (signal.aborted) throw new Error("aborted");
      try {
        const stdout = await runAdapter(a, query, signal, opts);
        const results = parseResults(stdout);
        if (results.length > 0) return results;
        errors.push(`${a}: empty`);
      } catch (err) {
        errors.push(`${a}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`opencli adapters exhausted: ${errors.join("; ")}`);
  },
};
