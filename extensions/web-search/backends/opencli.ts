// backends/opencli.ts

import { spawn, execFile } from "node:child_process";
import { connect } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
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
    // opencli talks to its own daemon (default port 19825). If the daemon
    // isn't listening, skip instantly — no amount of waiting will help.
    const port = Number(process.env.OPENCLI_DAEMON_PORT) || 19825;
    const tcpOk = await new Promise<boolean>((resolve) => {
      const sock = connect({ host: "127.0.0.1", port });
      const t = setTimeout(() => { sock.destroy(); resolve(false); }, 300);
      sock.once("connect", () => { clearTimeout(t); sock.end(); resolve(true); });
      sock.once("error", () => { clearTimeout(t); resolve(false); });
    });
    if (!tcpOk) return false;
    // Daemon is listening. The extension may be disconnected, but
    // search() will attempt to wake it — don't skip here.
    return true;
  },

  async search(query, signal, opts) {
    // Auto-wake: if the daemon is running but the extension is disconnected,
    // launch headed Chromium with the unpacked extension. Falls through to
    // adapter search if wakeup succeeds (or extension was already connected).
    const woke = await wakeOpencli();
    if (!woke) {
      throw new Error(
        "opencli Browser Bridge extension not connected. " +
        "Install the extension from https://github.com/jackwener/opencli/releases " +
        "or run Chromium with --remote-debugging-port."
      );
    }

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

// ── Auto-wake: launch Chromium for the Browser Bridge extension ────────
// The opencli daemon (port 19825) needs a headed Chromium instance with the
// Browser Bridge extension loaded. If no such Chrome is running, opencli
// commands hang until timeout. This section auto-launches one.

const CHROMIUM_BIN = process.env.OPENCLI_CHROMIUM_BIN || "chromium";
const DEFAULT_PROFILE = path.join(homedir(), ".config", "chromium");
const OPENCLI_CDP_PORT = 19826;
const WAKE_TIMEOUT_S = 10;
const EXT_SCAN_MAX_DEPTH = 5;
const BROWSER_CONFIG_ROOTS = [
  path.join(homedir(), ".config", "chromium"),
  path.join(homedir(), ".config", "google-chrome"),
  path.join(homedir(), ".config", "google-chrome-beta"),
  path.join(homedir(), ".config", "BraveSoftware", "Brave-Browser"),
  path.join(homedir(), ".config", "BraveSoftware", "Brave-Browser-Beta"),
];

function looksLikeOpencliManifest(manifestPath: string): boolean {
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    return /opencli/i.test(raw) || /Browser Bridge/i.test(raw);
  } catch {
    return false;
  }
}

function scanForOpencliExtension(dir: string, depth = 0): string | null {
  if (depth > EXT_SCAN_MAX_DEPTH) return null;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    const manifestPath = path.join(full, "manifest.json");

    if (
      fs.existsSync(manifestPath) &&
      (/opencli/i.test(entry.name) || looksLikeOpencliManifest(manifestPath))
    ) {
      return full;
    }

    const nested = scanForOpencliExtension(full, depth + 1);
    if (nested) return nested;
  }

  return null;
}

function findExtensionDir(): string | null {
  const override = process.env.OPENCLI_EXTENSION_DIR?.trim();
  if (override) {
    const manifestPath = path.join(override, "manifest.json");
    if (fs.existsSync(manifestPath)) return override;
  }

  for (const root of BROWSER_CONFIG_ROOTS) {
    const found = scanForOpencliExtension(root);
    if (found) return found;
  }

  return null;
}

function daemonExtensionConnected(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("opencli", ["daemon", "status"], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(!stdout.includes("Extension: disconnected"));
    });
  });
}

async function killOpencliChrome(): Promise<void> {
  try {
    const r = await fetch(`http://127.0.0.1:${OPENCLI_CDP_PORT}/json/version`);
    if (!r.ok) return;
    const listR = await fetch(`http://127.0.0.1:${OPENCLI_CDP_PORT}/json/list`);
    const pages = (await listR.json()) as Array<{ id: string }>;
    for (const p of pages) {
      await fetch(`http://127.0.0.1:${OPENCLI_CDP_PORT}/json/close/${p.id}`).catch(() => {});
    }
  } catch {}
}

async function wakeOpencli(): Promise<boolean> {
  if (await daemonExtensionConnected()) return true;
  const extDir = findExtensionDir();
  if (!extDir) return false;
  await killOpencliChrome();

  const proc = spawn(CHROMIUM_BIN, [
    `--remote-debugging-port=${OPENCLI_CDP_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${DEFAULT_PROFILE}`,
    `--load-extension=${extDir}`,
    "--disable-session-crashed-bubble",
    "--disable-infobars",
    "about:blank",
    "--keep-alive-for-testing",
  ], { detached: true, stdio: "ignore" });
  proc.unref();

  const deadline = Date.now() + WAKE_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await daemonExtensionConnected()) return true;
  }
  return false;
}
