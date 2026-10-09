/**
 * Auto Title — 用一句中文短标题总结对话，写进 pi 的会话名。
 *
 * pi 把会话名写进终端标题（`π - 名字 - 目录`），herdr 的 tab 不会自己读它，只有
 * `herdr tab rename` 能改 tab 名。所以在 herdr 里跑时，这个扩展顺手把 tab 名也改成会话名；
 * 不在 herdr 里（没有 HERDR_TAB_ID）就只写会话名，别的都不做。
 *
 * 行为：
 * - 挂 `agent_settled`（一轮彻底结束、不会被自动续跑时触发）。aborted 的那轮跳过。
 * - 第一次生成：会话里还没有本扩展的记录时，第一轮结束就生成。
 * - 之后刷新：距上次生成累计新增 `refreshTokens` 个 token（每轮 assistant 的
 *   usage.totalTokens 之和，含输入与输出）才重新生成。
 * - 保护手改：当前会话名跟本扩展上次写的对不上，说明是人手改的，就不再自动更新。
 *   会话一开始就带名字（`pi -n xxx`）同样不碰。
 * - 生成失败、模型没配、名字没变化：都静默返回，不动旧标题，不刷屏。
 * - `/retitle` 手动强制重算一次（会覆盖手改的名字）。
 * - tab 名：生成新名字、恢复会话、退出时各同步一次；人手改过的 tab 名不碰。
 *
 * 只注册命令，不注册工具：它是给人用的，不是给模型调的。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** 会话里记录「上次写到会话名的标题」的条目类型。 */
const MARKER = "auto-title";

const DEFAULTS = {
	/** 距上次生成累计新增多少 token 后刷新标题。 */
	refreshTokens: 20_000,
	/** 标题字数上限（中文按字算）。 */
	maxChars: 6,
	/** 喂给模型的对话摘录长度上限（字符）。 */
	excerptChars: 6_000,
};

type Config = typeof DEFAULTS;

/**
 * 读 `$PI_CODING_AGENT_DIR/extensions/auto-title.json`，缺文件或字段就用默认值。
 * 坏 JSON 不抛错，退回默认值，免得扩展加载失败。
 */
function loadConfig(): Config {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const file = join(agentDir, "extensions", "auto-title.json");
	try {
		if (!existsSync(file)) return { ...DEFAULTS };
		const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
		return {
			refreshTokens: positive(raw.refreshTokens, DEFAULTS.refreshTokens),
			maxChars: positive(raw.maxChars, DEFAULTS.maxChars),
			excerptChars: positive(raw.excerptChars, DEFAULTS.excerptChars),
		};
	} catch {
		return { ...DEFAULTS };
	}
}

function positive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

/** 设 PI_AUTO_TITLE_DEBUG=1 才输出，用来查「为什么标题没变」。 */
function debug(message: string): void {
	if (process.env.PI_AUTO_TITLE_DEBUG === "1") {
		process.stderr.write(`[auto-title] ${message}\n`);
	}
}

/** 消息 content 可能是字符串，也可能是分块数组；只取文字块，丢掉 thinking 和工具调用。 */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				!!part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

type SessionRow = {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
	message?: { role?: unknown; content?: unknown; usage?: { totalTokens?: unknown } };
};

function rows(ctx: ExtensionContext): SessionRow[] {
	return ctx.sessionManager.getEntries() as unknown as SessionRow[];
}

/** 找本扩展最后一次写入的标题记录，返回它在条目里的下标。 */
function lastMarker(
	ctx: ExtensionContext,
): { index: number; name: string } | undefined {
	const all = rows(ctx);
	for (let i = all.length - 1; i >= 0; i -= 1) {
		const row = all[i];
		if (row.type !== "custom" || row.customType !== MARKER) continue;
		const name = (row.data as { name?: unknown } | undefined)?.name;
		return { index: i, name: typeof name === "string" ? name : "" };
	}
	return undefined;
}

/** 上次生成之后，assistant 消息累计用掉的 token。没有记录就从会话开头算。 */
function tokensSince(ctx: ExtensionContext, fromIndex: number): number {
	let total = 0;
	for (const row of rows(ctx).slice(fromIndex + 1)) {
		const message = row.message;
		if (row.type !== "message" || message?.role !== "assistant") continue;
		const used = message.usage?.totalTokens;
		if (typeof used === "number" && Number.isFinite(used)) total += used;
	}
	return total;
}

/** 拼一段对话摘录给模型看：只在首条用户消息特别长时才截它，末尾始终保留。 */
function excerpt(ctx: ExtensionContext, limit: number): string {
	const lines: string[] = [];
	for (const row of rows(ctx)) {
		const message = row.message;
		if (row.type !== "message" || !message) continue;
		const text = textOf(message.content);
		if (!text) continue;
		if (message.role === "user") lines.push(`用户：${text}`);
		else if (message.role === "assistant") lines.push(`助手：${text}`);
	}
	const joined = lines.join("\n\n");
	if (joined.length <= limit) return joined;
	const tail = joined.slice(-Math.floor(limit * 0.8));
	const head = joined.slice(0, limit - tail.length);
	return `${head}\n\n……（中间省略）……\n\n${tail}`;
}

/** 去掉引号、句末标点、markdown 记号，并按「字」截断（不切坏代理对）。 */
function normalize(raw: string, maxChars: number): string | undefined {
	const cleaned = raw
		.split("\n")[0]
		.replace(/[`*_#>]/g, "")
		.replace(/^[\s「『“”"'《》【】\[(]+/, "")
		.replace(/[\s」』“”"'《》【】\])]+$/, "")
		.replace(/[。.，,、；;：:！!？?~～-]+$/, "")
		.trim();
	if (!cleaned) return undefined;
	return Array.from(cleaned).slice(0, maxChars).join("");
}

/** 生成标题用的系统提示。第二次尝试时明说上一次混了英文。 */
function titlePrompt(cfg: Config, attempt: number): string {
	const base =
		`你给编程对话起标题。用纯中文名词短语概括这段对话在做什么，最多 ${cfg.maxChars} 个字。` +
		"只输出标题本身：不要引号、不要句末标点、不要解释。" +
		"去掉「两种」「关于」「的区别」「的讨论」这类可有可无的修饰，只留核心词，越短越好。" +
		"标题里绝对不能出现英文字母、英文单词、函数名或缩写；即使对话里全是英文术语，也要换成中文说法。" +
		"例如「批量等待容错」。";
	return attempt === 1
		? base
		: `${base}上一次的标题里混进了英文，这次必须全部用中文表达。`;
}

/** 用当前会话模型生成标题，最多试两次（第二次针对英文残留）。失败都返回 undefined。 */
async function generateTitle(
	ctx: ExtensionContext,
	cfg: Config,
): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) {
		debug("跳过：ctx.model 为空");
		return undefined;
	}

	const transcript = excerpt(ctx, cfg.excerptChars);
	if (!transcript.trim()) {
		debug("跳过：对话摘录为空");
		return undefined;
	}

	const messages = [
		{
			role: "user" as const,
			content: `对话记录：\n\n${transcript}`,
			timestamp: Date.now(),
		},
	];

	for (let attempt = 1; attempt <= 2; attempt += 1) {
		const reply = await ctx.modelRegistry.complete(model, {
			systemPrompt: titlePrompt(cfg, attempt),
			messages,
		});
		const name = normalize(textOf(reply.content), cfg.maxChars);
		if (!name) {
			debug(`第 ${attempt} 次尝试没得到可用标题`);
			continue;
		}
		if (/[A-Za-z]/.test(name)) {
			debug(`第 ${attempt} 次尝试含英文字母（${name}），重试`);
			continue;
		}
		return name;
	}

	return undefined;
}

// ------------------------------------------------------------------ herdr

/** herdr 注入的当前 tab 和 workspace；不在 herdr 里跑时是 undefined。 */
function herdrTarget(): { tab: string; workspace: string } | undefined {
	const tab = process.env.HERDR_TAB_ID;
	const workspace = process.env.HERDR_WORKSPACE_ID;
	return tab && workspace ? { tab, workspace } : undefined;
}

/** 跑一条 herdr 命令并返回 stdout；失败返回 undefined（不改标题，不刷屏）。 */
function herdr(args: string[]): string | undefined {
	try {
		return String(
			execFileSync(process.env.HERDR_BIN_PATH ?? "herdr", args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				// 同步调用会挡住 TUI，所以宁可早点失败。
				timeout: 2_000,
			}),
		);
	} catch (error) {
		debug(`herdr ${args.slice(0, 2).join(" ")} 失败：${(error as Error).message}`);
		return undefined;
	}
}

/**
 * 当前 tab 的标签，以及它在 workspace 里的序号 —— herdr 的默认标签就是序号，
 * 所以这个序号既是「没被改过」的判据，也是退出时要还回去的值。
 */
function tabState(): { tab: string; label: string; number: string } | undefined {
	const target = herdrTarget();
	if (!target) return undefined;
	const raw = herdr(["tab", "list", "--workspace", target.workspace]);
	if (!raw) return undefined;
	try {
		const tabs =
			(
				JSON.parse(raw) as {
					result?: { tabs?: { tab_id?: string; label?: string }[] };
				}
			).result?.tabs ?? [];
		const index = tabs.findIndex((tab) => tab.tab_id === target.tab);
		if (index < 0) return undefined;
		return {
			tab: target.tab,
			label: tabs[index].label ?? "",
			number: String(index + 1),
		};
	} catch (error) {
		debug(`解析 tab list 失败：${(error as Error).message}`);
		return undefined;
	}
}

/**
 * 把当前 tab 改名。只在 herdr 的默认数字、本扩展上次写的名字（`mine`）上改，
 * 人手改过的名字不动。
 */
function nameTab(want: string, mine?: string): void {
	const state = tabState();
	if (!state || state.label === want) return;
	if (state.label !== state.number && state.label !== mine) {
		debug(`跳过：tab 名 "${state.label}" 不是本扩展写的`);
		return;
	}
	if (herdr(["tab", "rename", state.tab, want]) !== undefined) {
		debug(`已改 tab 名：${want}`);
	}
}

export default function activate(pi: ExtensionAPI): void {
	const cfg = loadConfig();

	async function retitle(ctx: ExtensionContext, force: boolean): Promise<string | undefined> {
		const last = lastMarker(ctx);
		const current = pi.getSessionName();

		if (!force) {
			// 会话名跟本扩展上次写的对不上 = 人手改的，或本来就是 `pi -n` 起的，不碰。
			if (current !== undefined && current !== last?.name) {
				debug(`跳过：会话名 "${current}" 不是本扩展写的（手改或 -n 起的）`);
				return undefined;
			}
			const spent = last ? tokensSince(ctx, last.index) : 0;
			if (last && spent < cfg.refreshTokens) {
				debug(`跳过：距上次生成只用了 ${spent} token（阈值 ${cfg.refreshTokens}）`);
				return undefined;
			}
		}

		const name = await generateTitle(ctx, cfg);
		if (!name) {
			debug("跳过：模型没给出可用标题");
			return undefined;
		}
		if (name === last?.name) {
			debug(`跳过：标题没变（${name}）`);
			return undefined;
		}

		pi.setSessionName(name);
		pi.appendEntry(MARKER, { name });
		debug(`已写入会话名：${name}`);
		nameTab(name, last?.name);
		return name;
	}

	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted) {
			debug("跳过：这一轮是 aborted");
			return;
		}
		// 必须在这里 await：handler 返回后 ctx 会失效（session replacement / reload 守卫），
		// 再做异步工作会报 "ctx is stale"。agent_settled 之后已无自动工作，阻塞它是安全的。
		try {
			await retitle(ctx, false);
		} catch (error) {
			debug(`生成失败：${(error as Error).message}`);
		}
	});

	// 恢复会话、或 herdr 重启后 tab 名会退回数字，这里补一次。
	pi.on("session_start", async () => {
		const name = pi.getSessionName();
		if (name) nameTab(name);
	});

	// pi 退出后 tab 会留着旧名字，改回序号。
	pi.on("session_shutdown", async () => {
		const name = pi.getSessionName();
		const state = tabState();
		if (name && state && state.label === name) nameTab(state.number, name);
	});

	pi.registerCommand("retitle", {
		description: "重新生成中文短标题并写入会话名（会覆盖手改的名字）",
		handler: async (_args, ctx) => {
			try {
				const name = await retitle(ctx, true);
				ctx.ui.notify(
					name ? `标题已更新：${name}` : "标题未更新（模型不可用或对话为空）",
					name ? "info" : "warning",
				);
			} catch (error) {
				ctx.ui.notify(`标题生成失败：${(error as Error).message}`, "error");
			}
		},
	});
}
