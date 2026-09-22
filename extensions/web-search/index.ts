/**
 * Web Search — 多后端回退链版
 *
 * 默认链：brave → browser-probe
 * 配置：
 *   - PI_WEB_SEARCH_CHAIN="brave,browser-probe"
 *   - PI_WEB_SEARCH_TIMEOUT_BRAVE / _BROWSER_PROBE  (毫秒)
 *   - PI_WEB_SEARCH_TOTAL_TIMEOUT  (毫秒，默认 25000)
 *   - PI_WEB_SEARCH_BROWSER_PROBE_BACKEND=auto|harness|playwright
 *   - PI_WEB_SEARCH_ENGINE=google|bing  (默认 google，失败回退 bing)
 *   - PI_WEB_SEARCH_CDP_URL  (显式指定浏览器调试端口；不设时自动用
 *     browser-probe 当前 session 的浏览器，再退回 127.0.0.1:9222)
 *   - PI_WEB_SEARCH_CDP_DISCOVER=0  (关掉上面的自动发现)
 *   - BRAVE_SEARCH_API_KEY  (Brave 后端启用条件)
 *
 * 运行时调用参数 chain 数组可临时覆盖。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

import { tryLoadEnv } from "../_common/tools/cli-helpers.ts";
import { registerBackend, registerDefaultBackends, runChain, loadConfig, listBackends, FAST_OPTION_DESC } from "./chain.ts";
import type { BackendAttempt, SearchResult } from "./backends/types.ts";

tryLoadEnv();

// Re-exports for third-party extensions that want to register additional
// backends without reaching into internal paths. A separate extension can
// `import { registerBackend } from "pi-web-search"` (or relative-import this
// module) and call `registerBackend({...})` from its own `default` entry
// point — the new backend then joins the existing fallback chain and can be
// selected via `PI_WEB_SEARCH_CHAIN` or `--chain`. Keeping this surface
// small and stable; do NOT re-export internal validation / filter helpers.
export { registerBackend, listBackends };
export type { Backend, SearchOptions, SearchResult, BackendAttempt } from "./backends/types.ts";

registerDefaultBackends();

function formatResults(backend: string, results: SearchResult[]): string {
  const lines: string[] = [`[backend: ${backend}] (${results.length} results)`, ""];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push("");
  });
  return lines.join("\n");
}

// JSON variant for the pi-internal tool call path. Agents handle structured
// JSON more reliably than markdown lists, and snippets often contain markdown
// bytes that confuse downstream parsers. Human surfaces use `formatResults()`.
function formatResultsJson(backend: string, results: SearchResult[]): string {
  return JSON.stringify({ ok: true, backend, count: results.length, results }, null, 2);
}

function formatFailureJson(query: string, attempts: BackendAttempt[]): string {
  return JSON.stringify(
    {
      ok: false,
      query,
      attempts: attempts.map((a) => ({
        name: a.name,
        kind: a.status.kind,
        reason: a.status.kind === "ok" ? undefined : a.status.reason,
        elapsedMs: a.elapsedMs,
      })),
    },
    null,
    2,
  );
}

function formatFailure(query: string, attempts: BackendAttempt[]): string {
  const lines = [`Web search failed for "${query}". Backends tried:`];
  for (const a of attempts) {
    const tag =
      a.status.kind === "skipped"
        ? "SKIPPED"
        : a.status.kind === "failed"
          ? "FAILED"
          : a.status.kind === "empty"
            ? "EMPTY"
            : "OK";
    const reason =
      a.status.kind === "ok"
        ? `${a.status.resultCount} results`
        : a.status.reason;
    lines.push(`  - ${a.name}: ${tag} (${reason}) [${a.elapsedMs}ms]`);
  }
  if (attempts.length === 0) {
    lines.push("  (no backends registered or chain is empty)");
  }
  lines.push("");
  lines.push(
    "Hint: set BRAVE_SEARCH_API_KEY, or make the browser-probe fallback available " +
      "(browser-harness on PATH, or Chrome running with --remote-debugging-port=9222).",
  );
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via Brave → browser-probe fallback chain (browser-probe = a real Chrome SERP; call it directly as " +
      "`browser_probe [\"search\", \"<query>\"]`). " +
      "Returns ranked URLs with titles and short snippets — NOT full page content. " +
      "To read a result's full content, call web_fetch on its URL. " +
      "For site-scoped search (Zhihu/Bilibili/YouTube/WeChat Official Accounts/etc.), prefer the site's dedicated CLI when one is installed; Zhihu has `zhihu search|global|hot`.",
    promptSnippet: "Search the web with backend fallback",
    promptGuidelines: [
      "Use web_search to DISCOVER URLs. Snippets are previews, not answers — follow up with web_fetch on top results to read full pages.",
      "For structured site search (Bilibili, YouTube, arXiv, etc.), prefer a dedicated site CLI via bash when one is installed (e.g. `zhihu search <query>`); otherwise fall back to web_search or the browser_probe `search` surface.",
      "For Zhihu content, use the `zhihu` CLI via bash: `zhihu search <query>` (on-site) / `zhihu global <query>` (whole web) / `zhihu hot` (trending). Output is a JSON envelope — parse with `jq`, not `head`/`grep`. It needs no login. Use it instead of a general web_search for Zhihu questions and answers.",
      "When Brave returns nothing, you want a rendered SERP, or you need a specific engine (`--engine baidu`), search directly with the browser_probe tool: `[\"search\", \"<query>\"]` — same browser the chain falls back to.",
      "Match the channel to the query TYPE, not to the result count: Brave is the default and is solid for English technical queries, while Chinese-language, hot-topic, and community questions are its weak spot — use the `zhihu` CLI or re-call this tool with `chain: [\"browser-probe\"]` there. The chain escalates only when a backend returns nothing, so a full page of SEO mirrors or content-farm pages means the channel is wrong, not that the query needs rephrasing.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      fast: Type.Optional(
        Type.Boolean({ description: FAST_OPTION_DESC, default: false }),
      ),
      chain: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Chain override for this call — also the quality escape hatch. `['browser-probe']` forces the second engine's SERP (independent index and different locale coverage); `['brave']` forces Brave only; `['exa','brave']` opts in a backend that is out of the default chain. Unknown names are silently dropped.",
        }),
      ),
      proxy: Type.Optional(
        Type.String({
          description:
            "Optional per-call proxy URL (e.g. http://127.0.0.1:7890). Honored by the brave backend; browser-probe (CDP) ignores per-call override.",
        }),
      ),
    }),
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as {
        query?: string;
        q?: string;
        chain?: string[];
        proxy?: string;
      };
      if (!input.query && input.q) {
        return { ...input, query: input.q };
      }
      return args;
    },

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Search cancelled" }] };
      }

      onUpdate?.({
        content: [
          { type: "text", text: `Searching for: "${params.query}"...` },
        ],
      });

      const effectiveSignal = signal ?? new AbortController().signal;
      const result = await runChain(params.query, effectiveSignal, {
        chain: params.chain,
        fast: params.fast,
        proxy: params.proxy,
      });

      // pi tool path → JSON. The `details` field still carries the chain
      // attempts in structured form; the text content is the agent-facing
      // payload.
      let text: string;
      if (result.kind === "ok") {
        text = formatResultsJson(result.backend, result.results);
      } else {
        text = formatFailureJson(params.query, result.attempts);
      }

      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let output = truncation.content;
      if (truncation.truncated) {
        output += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines shown]`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: {
          query: params.query,
          fast: params.fast ?? false,
          chain: result.kind === "ok" ? result.backend : "FAILED",
          attempts: result.attempts.map((a) => ({
            name: a.name,
            kind: a.status.kind,
            elapsedMs: a.elapsedMs,
          })),
        },
      };
    },
  });

  pi.registerCommand("web-search", {
    description: "Search the web (e.g. /web-search rust async tutorial)",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /web-search <query>", "warning");
        return;
      }
      const result = await runChain(args, ctx.signal ?? new AbortController().signal);
      const text =
        result.kind === "ok"
          ? formatResults(result.backend, result.results)
          : formatFailure(args, result.attempts);

      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let output = truncation.content;
      if (truncation.truncated) {
        output += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines shown]`;
      }
      ctx.ui.notify(output, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const cfg = loadConfig();
    ctx.ui.notify(
      `🔌 Web Search loaded — chain: ${cfg.chain.join(" → ") || "(empty)"}`,
      "info",
    );
  });
}
