// Model Prompt — 按模型给系统提示词加一段专属内容
//
// 为什么需要它：pi 只有按模型的次要设置（settings.md 有 modelThinkingLevels、
// compaction.modelOverrides），没有「按模型换系统提示词」。强模型和弱模型共用同一份
// 提示词，要么浪费强模型，要么对弱模型说得不够。pi 的 before_agent_start 事件能改
// systemPromptOptions，且处理器里 ctx.model 就是这次要跑的模型，所以按模型分支可行。
//
// 配置就是一个目录（默认插件目录下的 prompts/），一个模型一个文件：
//   prompts/<provider>/<modelId>.md   provider/modelId 专属
//   prompts/<provider>/_default.md    provider 级兜底（原来的 provider/*）
//   prompts/_default.md               所有模型都加（原来的 *）
// 匹配顺序从上往下，第一个存在的文件生效。可用 PI_MODEL_PROMPTS_DIR 换目录。
// 文件内容作为 <model_guidance> 段落追加，不改动其余提示词。
//
// 只做加法：写 event.systemPromptOptions.sections，不整体替换 system prompt。
// 这样 pi 仍能增量记录结构化段落，提示词前缀保持稳定（对 DeepSeek 前缀缓存计价有用）。
// 目录缺失、文件为空或没有命中时，本扩展什么都不做。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 追加段落的标签名，渲染成 <model_guidance>…</model_guidance>。 */
const SECTION = "model_guidance";

/** provider 级 / 全局兜底的文件名。 */
const FALLBACK = "_default.md";

/** 提示词目录与插件同目录：配置随插件目录一起版本管理。 */
const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

type Model = { provider?: string; id?: string } | undefined;

function promptsDir(): string {
	return process.env.PI_MODEL_PROMPTS_DIR || DEFAULT_DIR;
}

/** 每次读取而非缓存：改完文件下一次请求即生效，不必重启 pi。 */
function readPrompt(file: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	return text.trim() === "" ? undefined : text;
}

/** 按匹配顺序列出候选文件路径。 */
function candidates(model: Model): string[] {
	const dir = promptsDir();
	if (!model?.provider) return [join(dir, FALLBACK)];
	const scoped = join(dir, model.provider);
	return [
		...(model.id ? [join(scoped, `${model.id}.md`)] : []),
		join(scoped, FALLBACK),
		join(dir, FALLBACK),
	];
}

/** 返回第一个存在且非空的文件；都没命中返回 undefined。 */
function resolve(model: Model): { file: string; text: string } | undefined {
	for (const file of candidates(model)) {
		const text = readPrompt(file);
		if (text !== undefined) return { file, text };
	}
	return undefined;
}

export default function modelPrompt(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const hit = resolve(ctx.model);
		if (hit) {
			event.systemPromptOptions.sections[SECTION] = hit.text;
		} else {
			delete event.systemPromptOptions.sections[SECTION];
		}
	});

	// 诊断用：告诉你当前模型读了哪个文件（不命中说明文件放错位置或名字写错）。
	pi.registerCommand("model-prompt", {
		description: "Show the per-model prompt file active for the current model",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			const hit = resolve(model);
			const who = `${model?.provider}/${model?.id}`;
			ctx.ui.notify(
				hit
					? `model-prompt: ${who} ← ${hit.file}`
					: `model-prompt: ${who} — no file matched\nlooked in: ${promptsDir()}`,
				"info",
			);
		},
	});
}
