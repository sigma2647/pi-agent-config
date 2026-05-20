/**
 * Web Search — 多后端回退链版
 *
 * 默认链：brave → opencli → browser
 * 配置：
 *   - PI_WEB_SEARCH_CHAIN="brave,opencli,browser"
 *   - PI_WEB_SEARCH_TIMEOUT_BRAVE / _OPENCLI / _BROWSER  (毫秒)
 *   - PI_WEB_SEARCH_TOTAL_TIMEOUT  (毫秒，默认 15000)
 *   - PI_WEB_SEARCH_BROWSER_BACKEND=auto|harness|playwright
 *   - BRAVE_SEARCH_API_KEY  (Brave 后端启用条件)
 *
 * 运行时调用参数 chain 数组可临时覆盖。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

import { registerBackend, runChain, loadConfig } from "./chain";
import { braveBackend } from "./backends/brave";
import { opencliBackend } from "./backends/opencli";
import { browserBackend } from "./backends/browser";
import type { BackendAttempt, SearchResult } from "./backends/types";

registerBackend(braveBackend);
registerBackend(opencliBackend);
registerBackend(browserBackend);

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
        ? `${a.status.results.length} results`
        : a.status.reason;
    lines.push(`  - ${a.name}: ${tag} (${reason}) [${a.elapsedMs}ms]`);
  }
  if (attempts.length === 0) {
    lines.push("  (no backends registered or chain is empty)");
  }
  lines.push("");
  lines.push(
    "Hint: set BRAVE_SEARCH_API_KEY, ensure opencli Browser Bridge is connected, " +
      "or install browser-harness.",
  );
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via Brave → opencli → browser fallback chain. " +
      "Returns search results with titles, URLs, and snippets. " +
      "Use this for current information, recent events, docs, and API references.",
    promptSnippet: "Search the web with backend fallback",
    promptGuidelines: [
      "Use web_search when the user asks about current events, recent information, or facts you are not confident about.",
      "Use web_search when you need to look up documentation, APIs, or technical references online.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      mode: StringEnum(["instant", "full"] as const, {
        description:
          '"instant" returns from the first available backend; "full" runs the full chain until a non-empty match',
        default: "full",
      }),
      chain: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional override of the fallback chain (e.g. ['opencli','brave']). Unknown names are silently dropped.",
        }),
      ),
    }),
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as {
        query?: string;
        mode?: string;
        q?: string;
        chain?: string[];
      };
      if (!input.query && input.q) {
        return { ...input, query: input.q };
      }
      if (!input.mode) {
        return { ...input, mode: "full" };
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
        shortCircuit: params.mode === "instant",
      });

      let text: string;
      if (result.kind === "ok") {
        text = formatResults(result.backend, result.results);
      } else {
        text = formatFailure(params.query, result.attempts);
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
          mode: params.mode,
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

  pi.registerCommand("search", {
    description: "Search the web (e.g. /search rust async tutorial)",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /search <query>", "warning");
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
