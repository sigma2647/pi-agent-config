// DeepSeek Cache Optimizer — 前缀缓存命中优化扩展
//
// 方法来源：DeepSeek Harness (github.com/deepseek-ai/deepseek-harness) 的缓存设计，
// 以及 pi 自身扩展体系。DeepSeek 官方 API 使用自动前缀缓存：请求前缀从第 0 字节起
// 与之前完全一致时，该部分按缓存价计费（便宜 50~120 倍）。本扩展做三件事让前缀稳定：
//
//  1. CWD 前缀稳定化：把 pi 缝在 system prompt 末尾的 "Current working directory"
//     动态行移出，改为在每次请求的消息流尾部追加一条固定文本消息。
//     （system prompt 完全静态 → 前缀稳定；对应 dsh 的 RuntimeContextProjection 思路）
//
//  2. 压缩前缀复用（compaction-summary-prefix-cache-reuse）：
//     接管 session_before_compact，压缩请求 = 当前 system prompt + 历史消息原样重放
//     （convertToLlm，与主请求字节一致）+ 末尾追加压缩指令。压缩指令放尾部而不是
//     独立的 summarizer system prompt，让压缩调用成为热请求的"前缀扩展"，命中缓存。
//     pi 默认压缩用独立 summarizer + cacheRetention: "none"，本扩展反其道而行。
//
//  3. 命中率遥测：/cache-stats 命令显示会话级缓存命中率（pi 原生 footer 的 CH:XX.X%
//     是每轮命中率，本扩展统计累计值）。
//
// 只对 DeepSeek 模型生效（provider 为 deepseek 或模型 id 含 deepseek）。
// 开关环境变量（默认全开）：
//   PI_DSC_ENABLED=0             总开关
//   PI_DSC_CWD_MOVE=0            关闭模块 1
//   PI_DSC_COMPACTION_PREFIX=0   关闭模块 2
//   PI_DSC_TELEMETRY=0           关闭模块 3
//
// Subagent 兼容：pi-interactive-subagents 等 spawn 的子代理是独立 pi 进程，读同一份
// 全局 ~/.pi/agent/settings.json 与自动发现目录，因此本扩展（经 settings.json 的
// packages 链或全局 extensions 目录加载）对子代理进程天然生效，无需改 subagents。
//
// 已知取舍（v1）：
//  - 压缩请求不带 tools 字段（OpenAI 格式下 tools 在消息之后，system+messages 前缀
//    仍然命中；若某代理把 tools 拼在消息之前，命中率会下降，可再对齐）。
//  - 统计是进程级（/reload 后清零），不做跨会话持久化。

// @ts-nocheck

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

/** system prompt 末尾的 "Current working directory: <path>" 行（pi 注入的动态内容）。
 * 兼容默认路径（行尾无换行）和自定义 prompt 路径（行尾带 \n）：JS 的 $ 不匹配
 * 末尾换行之前的位置，所以允许 CWD 行后跟 0~n 个换行。 */
const CWD_RE = /[\r\n]+Current working directory: [^\r\n]*[\r\n]*$/;

function envFlag(name: string, def: boolean): boolean {
	const v = process.env[name];
	if (v === undefined || v === "") return def;
	return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

function isDeepSeek(model: { provider?: string; id?: string } | undefined): boolean {
	if (!model) return false;
	if (model.provider === "deepseek") return true;
	return /deepseek/i.test(model.id ?? "");
}

export default function deepseekCacheOptimizer(pi: ExtensionAPI) {
	const enabled = envFlag("PI_DSC_ENABLED", true);
	const cwdMove = envFlag("PI_DSC_CWD_MOVE", true);
	const compactionPrefix = envFlag("PI_DSC_COMPACTION_PREFIX", true);
	const telemetry = envFlag("PI_DSC_TELEMETRY", true);

	// 模块 1 状态：每个会话的"干净" system prompt（已移除 CWD 行）
	const cleanSystemPrompt = new Map<string, string>();

	// 模块 3 状态：会话级累计统计
	const stats = { input: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
	let statsEnabled = false;

	if (!enabled) return;

	// ============================================================
	// 模块 1a：before_agent_start — 从 system prompt 移除 CWD 动态行
	// ============================================================
	pi.on("before_agent_start", async (event, ctx) => {
		if (!cwdMove || !isDeepSeek(ctx.model)) return;

		const stripped = event.systemPrompt.replace(CWD_RE, "");
		if (stripped === event.systemPrompt) return;

		// 记录干净版本，供压缩模块复用（before_agent_start 的修改是 per-turn 的，
		// 压缩发生时 getSystemPrompt() 不一定反映它，所以显式缓存）。
		try {
			const id = ctx.sessionManager?.getSessionId?.();
			if (typeof id === "string" && id.length > 0) {
				cleanSystemPrompt.set(id, stripped);
			}
		} catch {
			// 忽略：无 sessionManager 时压缩模块走 fallback
		}

		return { systemPrompt: stripped };
	});

	// ============================================================
	// 模块 1b：context — 在消息流尾部追加固定 CWD 消息（变化只影响末尾）
	// ============================================================
	pi.on("context", (event, ctx) => {
		if (!cwdMove || !isDeepSeek(ctx.model)) return;

		const marker = `[Runtime context] Current working directory: ${ctx.cwd}`;

		// 尾部已有 CWD 消息且内容一致 → 无需改动（前缀稳定）
		const last = event.messages[event.messages.length - 1];
		if (last && last.role === "user" && typeof last.content === "string" && last.content === marker) {
			return;
		}
		// 尾部是 content 数组的 user 消息且内容一致 → 也跳过
		if (
			last &&
			last.role === "user" &&
			Array.isArray(last.content) &&
			last.content.length === 1 &&
			last.content[0]?.type === "text" &&
			last.content[0].text === marker
		) {
			return;
		}

		return {
			messages: [
				...event.messages,
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: marker }],
					timestamp: Date.now(),
				},
			],
		};
	});

	// ============================================================
	// 模块 2：session_before_compact — 压缩请求复用热前缀
	// ============================================================
	pi.on("session_before_compact", async (event, ctx) => {
		if (!compactionPrefix || !isDeepSeek(ctx.model)) return;

		const model = ctx.model;
		if (!model) return;

		const { preparation, customInstructions, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary, settings } =
			preparation;

		// 1) system prompt：优先用模块 1 记录的干净版本；否则取当前值再兜底移除一次
		let system = "";
		try {
			const id = ctx.sessionManager?.getSessionId?.();
			if (typeof id === "string" && cleanSystemPrompt.has(id)) {
				system = cleanSystemPrompt.get(id)!;
			}
		} catch {
			// fall through to getSystemPrompt
		}
		if (!system) {
			try {
				system = (ctx.getSystemPrompt?.() ?? "").replace(CWD_RE, "");
			} catch {
				system = "";
			}
		}

		// 2) 历史消息：convertToLlm 原样重放（与主请求字节一致）
		const llmMessages = convertToLlm([...messagesToSummarize, ...turnPrefixMessages]);

		// 3) 末尾追加压缩指令（而非独立 summarizer system prompt）
		const prevBlock = previousSummary
			? `Previous summary (from an earlier compaction) — continue and update it, do not discard it:\n${previousSummary}\n\n`
			: "";
		const focusBlock = customInstructions ? `Additional focus: ${customInstructions}\n\n` : "";
		const instruction =
			"You are now acting as a compaction engine. Condense the conversation above into a compact structured summary that preserves: exact file paths, function names, key decisions and rationale, current state of ongoing work, blockers, and planned next steps. Keep each section concise.\n\n" +
			prevBlock +
			focusBlock +
			"Output only the summary text. Do not call tools. Do not mention this request.";

		llmMessages.push({
			role: "user" as const,
			content: [{ type: "text" as const, text: instruction }],
			timestamp: Date.now(),
		});

		const maxTokens = Math.min(
			Math.floor(0.8 * (settings?.reserveTokens ?? 8192)),
			model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
		);

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: system, messages: llmMessages },
				{
					maxTokens,
					signal,
					// 与主请求一致的默认保留策略 → DeepSeek 自动前缀缓存命中。
					// 不传 cacheRetention: "none"（pi 默认压缩这么做，会放弃缓存复用）。
					cacheRetention: "short",
				},
			);

			const summary = (response.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (!summary) return; // 空摘要 → 回退 pi 默认压缩

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					usage: response.usage,
				},
			};
		} catch {
			// 任何失败都回退 pi 默认压缩，不中断会话
			return;
		}
	});

	// ============================================================
	// 模块 3：message_end 遥测 + /cache-stats 命令
	// ============================================================
	pi.on("message_end", (event, ctx) => {
		if (!telemetry || !isDeepSeek(ctx.model)) return;
		const m = event.message;
		if (!m || m.role !== "assistant" || !m.usage) return;
		stats.input += m.usage.input ?? 0;
		stats.cacheRead += m.usage.cacheRead ?? 0;
		stats.cacheWrite += m.usage.cacheWrite ?? 0;
		stats.calls += 1;
		statsEnabled = true;
	});

	pi.registerCommand("cache-stats", {
		description: "Show DeepSeek prefix-cache hit statistics for this session",
		handler: async (_args, ctx) => {
			if (!statsEnabled || stats.calls === 0) {
				ctx.ui.notify("No DeepSeek calls recorded yet in this process", "info");
				return;
			}
			const hitPct = stats.input > 0 ? ((stats.cacheRead / stats.input) * 100).toFixed(1) : "0.0";
			const fmt = (n: number) =>
				n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${n}`;
			ctx.ui.notify(
				`Cache hit ${hitPct}% — ${fmt(stats.cacheRead)} read / ${fmt(stats.input)} input, ${stats.calls} calls (process-scoped)`,
				"info",
			);
		},
	});
}
