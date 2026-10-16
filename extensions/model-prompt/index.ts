// Model Prompt — 按模型给系统提示词加一段专属内容
//
// 为什么需要它：pi 只有按模型的次要设置（settings.md 有 modelThinkingLevels、
// compaction.modelOverrides），没有「按模型换系统提示词」。强模型和弱模型共用同一份
// 提示词，要么浪费强模型，要么对弱模型说得不够。pi 的 before_agent_start 事件能改
// systemPromptOptions，且处理器里 ctx.model 就是这次要跑的模型，所以按模型分支可行。
//
// 配置文件：插件目录内的 model-prompts.json（与 index.ts 并排，随插件一起走），
// 可用 PI_MODEL_PROMPTS 换路径。内容示例：
//   {
//     "deepseek/deepseek-flash": "回答用中文，短句。",
//     "deepseek/*": "provider 级兜底",
//     "*": "所有模型都加"
//   }
// 键的匹配顺序：provider/modelId → modelId → provider/* → *。第一个命中的生效。
// 值是一段文本，作为 <model_guidance> 段落追加，不改动其余提示词。
//
// 只做加法：写 event.systemPromptOptions.sections，不整体替换 system prompt。
// 这样 pi 仍能增量记录结构化段落，提示词前缀保持稳定（对 DeepSeek 前缀缓存计价有用）。
// 配置缺失、损坏或没有命中规则时，本扩展什么都不做。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 追加段落的标签名，渲染成 <model_guidance>…</model_guidance>。 */
const SECTION = "model_guidance";

/** 配置与插件同目录：不往 ~/.pi/agent 放东西，配置随插件目录一起版本管理。 */
const DEFAULT_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "model-prompts.json");

type Config = Record<string, string>;

function configPath(): string {
	return process.env.PI_MODEL_PROMPTS || DEFAULT_CONFIG;
}

/** 每次读取而非缓存：改完配置文件下一次请求即生效，不必重启 pi。 */
function loadConfig(): Config {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath(), "utf8"));
	} catch {
		return {}; // 无文件或 JSON 损坏 → 静默不生效，绝不打断会话
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

	const out: Config = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value === "string" && value.trim() !== "") out[key] = value;
	}
	return out;
}

/** 返回命中的键名与文本；没命中返回 undefined。 */
function resolve(
	config: Config,
	model: { provider?: string; id?: string } | undefined,
): { key: string; text: string } | undefined {
	if (!model?.id) return config["*"] ? { key: "*", text: config["*"] } : undefined;

	const keys = [`${model.provider}/${model.id}`, model.id];
	if (model.provider) keys.push(`${model.provider}/*`);
	keys.push("*");

	for (const key of keys) {
		const text = config[key];
		if (typeof text === "string") return { key, text };
	}
	return undefined;
}

export default function modelPrompt(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const hit = resolve(loadConfig(), ctx.model);
		if (hit) {
			event.systemPromptOptions.sections[SECTION] = hit.text;
		} else {
			delete event.systemPromptOptions.sections[SECTION];
		}
	});

	// 诊断用：告诉你当前模型命中了哪条规则（不命中说明配置键写错了）。
	pi.registerCommand("model-prompt", {
		description: "Show the per-model prompt rule active for the current model",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			const hit = resolve(loadConfig(), model);
			const where = `${configPath()}`;
			ctx.ui.notify(
				hit
					? `model-prompt: ${model?.provider}/${model?.id} ← "${hit.key}"\n${where}`
					: `model-prompt: ${model?.provider}/${model?.id} — no rule matched\n${where}`,
				"info",
			);
		},
	});
}
