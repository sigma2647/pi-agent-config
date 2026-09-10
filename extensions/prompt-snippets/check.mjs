#!/usr/bin/env node
/**
 * 校验 prompt-snippets 下的所有 snippets/*.md 文件是否符合 snippet.schema.json 规范。
 *
 * 检查内容：
 * 1. 文件必须包含以 "---" 闭合的 YAML frontmatter 与非空正文
 * 2. frontmatter 属性必须符合 schema（name, description, placement, order）
 * 3. 不允许 schema 之外的未知属性
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaFile = path.join(__dirname, "snippet.schema.json");
const snippetsDir = path.join(__dirname, "snippets");

if (!existsSync(schemaFile)) {
	console.error(`✗ 未找到 Schema 文件: ${schemaFile}`);
	process.exit(1);
}

if (!existsSync(snippetsDir)) {
	console.error(`✗ 未找到 Snippets 目录: ${snippetsDir}`);
	process.exit(1);
}

const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
const allowedProperties = new Set(Object.keys(schema.properties ?? {}));
const allowedPlacements = new Set(schema.properties?.placement?.enum ?? ["prepend", "append"]);

const files = readdirSync(snippetsDir)
	.filter((f) => f.toLowerCase().endsWith(".md"))
	.sort();

if (files.length === 0) {
	console.warn(`! 在 ${snippetsDir} 中未找到任何 .md 文件`);
	process.exit(0);
}

let failed = 0;

for (const file of files) {
	const filePath = path.join(snippetsDir, file);
	const content = readFileSync(filePath, "utf8");
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

	if (!match) {
		console.error(`✗ ${file}: 缺少完整的 frontmatter（需用 '---' 包裹）`);
		failed++;
		continue;
	}

	const rawMeta = match[1];
	const body = match[2].trim();

	if (!body) {
		console.error(`✗ ${file}: 正文内容为空`);
		failed++;
		continue;
	}

	const meta = {};
	const errors = [];

	for (const line of rawMeta.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const kv = trimmed.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
		if (!kv) {
			errors.push(`无法解析的 frontmatter 行: "${line}"`);
			continue;
		}

		const key = kv[1].toLowerCase();
		const rawVal = kv[2].trim().replace(/^["']|["']$/g, "");

		if (!allowedProperties.has(key)) {
			errors.push(`未定义的未知属性: "${key}"`);
			continue;
		}

		if (key === "placement") {
			if (!allowedPlacements.has(rawVal)) {
				errors.push(`placement 取值无效: "${rawVal}"（仅支持 ${[...allowedPlacements].join(" | ")}）`);
			}
			meta.placement = rawVal;
		} else if (key === "order") {
			const parsed = Number.parseInt(rawVal, 10);
			if (!Number.isFinite(parsed)) {
				errors.push(`order 必须为有效整数: "${rawVal}"`);
			} else {
				meta.order = parsed;
			}
		} else {
			meta[key] = rawVal;
		}
	}

	if (errors.length > 0) {
		console.error(`✗ ${file}:`);
		for (const err of errors) {
			console.error(`    - ${err}`);
		}
		failed++;
	} else {
		const placement = meta.placement ?? schema.properties?.placement?.default ?? "append";
		const order = meta.order ?? schema.properties?.order?.default ?? 9999;
		const name = meta.name ?? file.replace(/\.md$/i, "");
		console.log(`✓ ${file} [${placement}, order ${order}] — ${name}`);
	}
}

if (failed > 0) {
	console.error(`\n校验失败: 共 ${failed} 个文件未通过检查`);
	process.exit(1);
}

console.log(`\n全部通过: ${files.length} 个 snippet 文件符合 ${path.basename(schemaFile)} 规范`);
