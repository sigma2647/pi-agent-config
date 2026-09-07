// DeepSeek Cache Optimizer — 前缀缓存命中优化扩展
//
// 方法来源：DeepSeek Harness (github.com/deepseek-ai/deepseek-harness) 的缓存设计，
// 以及 pi 自身扩展体系。DeepSeek 官方 API 使用自动前缀缓存：请求前缀从第 0 字节起
// 与之前完全一致时，该部分按缓存价计费（便宜 50~120 倍）。本扩展做三件事让前缀稳定：
//
//  1. CWD 前缀稳定化：把 pi 缝在 system prompt 末尾的 "Current working directory"
//     动态行移出，改为每次「轮」（turn）的消息流尾部追加一条固定文本消息。
//     （system prompt 完全静态 → 前缀稳定；对应 dsh 的 RuntimeContextProjection 思路）
//     只在轮首的真实 user 消息后追加一次，工具循环中不重复插入。
//
//  2. 压缩前缀复用（compaction-summary-prefix-cache-reuse）：【默认关闭】
//     接管 session_before_compact，压缩请求 = 当前 system prompt + 历史消息原样重放
//     + 末尾压缩指令，意图让压缩调用成为热请求的"前缀扩展"。
//     实测结论：压缩请求不带 tools 字段，而主请求带 tools；DeepSeek 把 tools 渲染进
//     prompt 前缀，因此压缩请求的前缀在 system 之后即与主请求分叉，只能命中 system
//     那一小段，历史消息整段 miss——"复用热前缀"的核心收益基本不成立。且该路径相比
//     pi 原生压缩丢失了结构化摘要与 fileOps 追踪。故默认关闭，改走 pi 原生压缩。
//
//  3. 命中率遥测：/cache-stats 显示累计缓存命中率，并持久化到磁盘（跨 /reload 与
//     重启保留）。命中率 = cacheRead / (input + cacheRead + cacheWrite)。pi 对 DeepSeek
//     的 usage 映射是 input = prompt_tokens - cacheRead - cacheWrite（即未命中 token），
//     因此分母必须是三者之和，不能用 input 单独当分母。
//
// 只对 DeepSeek 模型生效（provider 为 deepseek 或模型 id 含 deepseek）。
// 开关环境变量（默认全开，压缩模块默认关）：
//   PI_DSC_ENABLED=0             总开关
//   PI_DSC_CWD_MOVE=0            关闭模块 1
//   PI_DSC_COMPACTION_PREFIX=1   打开模块 2（不推荐，见上）
//   PI_DSC_TELEMETRY=0           关闭模块 3
//   PI_DSC_STATS_PATH=<path>     覆盖统计落盘路径（默认 ~/.pi/agent/extensions/deepseek-cache-optimizer/stats.json）
//
// Subagent 兼容：pi-interactive-subagents 等 spawn 的子代理是独立 pi 进程，读同一份
// 全局 ~/.pi/agent/settings.json 与自动发现目录，因此本扩展（经 settings.json 的
// packages 链或全局 extensions 目录加载）对子代理进程天然生效，无需改 subagents。
//
// 已知取舍（v2）：
//  - 模块 2 默认关：不带 tools 导致压缩请求前缀命中有限，且丢结构化摘要/fileOps。
//  - 统计持久化为累计值（跨会话/进程），不做按会话拆分；落盘失败静默，不影响会话。

// @ts-nocheck

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

// ============================================================
// 模块 3 支撑：累计统计 + 磁盘持久化（原子 tmp+rename，防抖落盘）
// ============================================================
interface CacheStats {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	calls: number;
	savedAt?: string;
}

const DEFAULT_STATS_PATH = join(
	homedir(),
	".pi",
	"agent",
	"extensions",
	"deepseek-cache-optimizer",
	"stats.json",
);
const statsPath = process.env.PI_DSC_STATS_PATH || DEFAULT_STATS_PATH;

const stats: CacheStats = { input: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
let statsLoaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;

function num(v: unknown): number {
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function loadStats(): Promise<void> {
	try {
		const raw = await readFile(statsPath, "utf8");
		const parsed = JSON.parse(raw) as Partial<CacheStats> | null;
		if (parsed && typeof parsed === "object") {
			stats.input += num(parsed.input);
			stats.cacheRead += num(parsed.cacheRead);
			stats.cacheWrite += num(parsed.cacheWrite);
			stats.calls += num(parsed.calls);
		}
	} catch {
		// 无文件或损坏 → 从零开始；遥测绝不能打断会话。
	} finally {
		statsLoaded = true;
	}
}

async function persistStats(): Promise<void> {
	if (saving) return;
	saving = true;
	try {
		await mkdir(dirname(statsPath), { recursive: true });
		const tmp = `${statsPath}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify({ ...stats, savedAt: new Date().toISOString() }));
		await rename(tmp, statsPath);
	} catch {
		// 落盘失败（如只读 home）静默。
	} finally {
		saving = false;
	}
}

function scheduleSave(): void {
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = null;
		void persistStats();
	}, 500);
	saveTimer.unref?.();
}

export default function deepseekCacheOptimizer(pi: ExtensionAPI) {
	const enabled = envFlag("PI_DSC_ENABLED", true);
	const cwdMove = envFlag("PI_DSC_CWD_MOVE", true);
	const compactionPrefix = envFlag("PI_DSC_COMPACTION_PREFIX", false);
	const telemetry = envFlag("PI_DSC_TELEMETRY", true);

	// 模块 1 状态：每个会话的"干净" system prompt（已移除 CWD 行）
	const cleanSystemPrompt = new Map<string, string>();

	if (!enabled) return;

	if (telemetry) void loadStats();

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
	// 模块 1b：context — 轮首在消息流尾部追加一次固定 CWD 消息
	// ============================================================
	pi.on("context", (event, ctx) => {
		if (!cwdMove || !isDeepSeek(ctx.model)) return;

		const marker = `[Runtime context] Current working directory: ${ctx.cwd}`;
		const last = event.messages[event.messages.length - 1];

		// 尾部已是本轮的 CWD 消息 → 前缀/尾部稳定，无需改动。
		if (last && last.role === "user") {
			const text =
				typeof last.content === "string"
					? last.content
					: Array.isArray(last.content) && last.content.length === 1 && last.content[0]?.type === "text"
						? last.content[0].text
						: undefined;
			if (text === marker) return;
		}

		// 只在轮首的真实 user 消息后追加一次。工具循环中 context 会在每个工具结果后
		// 再次触发，此时 last 是 toolResult/assistant；若再插 user 消息会（a）浪费 token、
		// （b）让模型误以为用户中途插话。
		if (!last || last.role !== "user") return;

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
	// 模块 2：session_before_compact — 压缩请求复用热前缀（默认关闭）
	//
	// 保留此路径供实验，但默认关：压缩请求不带 tools，前缀在 system 之后即与
	// 主请求分叉，历史消息基本命中不了；且相比 pi 原生压缩丢失结构化摘要与
	// fileOps 追踪。真正要保的是主循环（模块 1 已覆盖）。
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
			// 注意：此请求不带 tools，前缀命中有限（见模块 2 注释）。
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
	// 模块 3：message_end 遥测（+ 持久化）与 /cache-stats 命令
	// ============================================================
	pi.on("message_end", (event, ctx) => {
		if (!telemetry || !isDeepSeek(ctx.model)) return;
		const m = event.message;
		if (!m || m.role !== "assistant" || !m.usage) return;
		stats.input += m.usage.input ?? 0;
		stats.cacheRead += m.usage.cacheRead ?? 0;
		stats.cacheWrite += m.usage.cacheWrite ?? 0;
		stats.calls += 1;
		scheduleSave();
	});

	pi.on("session_shutdown", () => {
		if (!telemetry) return;
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		void persistStats();
	});

	pi.registerCommand("cache-stats", {
		description: "Show DeepSeek prefix-cache hit statistics for this session",
		handler: async (_args, ctx) => {
			if (!telemetry) {
				ctx.ui.notify("DeepSeek cache telemetry is disabled (PI_DSC_TELEMETRY=0)", "info");
				return;
			}
			if (stats.calls === 0) {
				ctx.ui.notify("No DeepSeek calls recorded yet", "info");
				return;
			}
			const total = stats.input + stats.cacheRead + stats.cacheWrite;
			const hitPct = total > 0 ? ((stats.cacheRead / total) * 100).toFixed(1) : "0.0";
			const fmt = (n: number) =>
				n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${n}`;
			const persisted = statsLoaded ? " · persisted" : "";
			ctx.ui.notify(
				`Cache hit ${hitPct}% — ${fmt(stats.cacheRead)} hit / ${fmt(total)} prompt (${fmt(stats.input)} uncached), ${stats.calls} calls${persisted}`,
				"info",
			);
		},
	});
}
