import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentSource = "bundled" | "global" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	model: string;
	thinking: string;
	systemPrompt: string;
	filePath: string;
	source?: AgentSource;
	subagentAgents?: string[];
	cwd?: string;
	denyTools?: string[];
	spawning?: boolean;
	autoExit?: boolean;
	interactive?: boolean;
	disableModelInvocation?: boolean;
}

export interface DiscoverAgentsOptions {
	bundledDir: string;
	projectCwd: string;
	globalConfigDir?: string;
	modelOverrides?: Record<string, string>;
}

export function parseFrontmatter<T = Record<string, string>>(content: string): { frontmatter: T; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {} as T, body: content };

	const values: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator < 0) continue;
		const key = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key) values[key] = value;
	}

	return { frontmatter: values as T, body: match[2].replace(/^\r?\n/, "") };
}

function splitList(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const items = value.split(",").map((item) => item.trim()).filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

export function parseAgentDefinition(
	filePath: string,
	source: AgentSource,
	modelOverrides: Record<string, string> = {},
): AgentConfig | null {
	const content = fs.readFileSync(filePath, "utf8");
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	const name = frontmatter.name || path.basename(filePath, ".md");
	if (!name) return null;

	return {
		name,
		description: frontmatter.description || "",
		tools: splitList(frontmatter.tools) ?? [],
		model: modelOverrides[name] ?? frontmatter.model ?? "openrouter/z-ai/glm-5.1",
		thinking: frontmatter.thinking || "medium",
		systemPrompt: body,
		filePath,
		source,
		subagentAgents: splitList(frontmatter.subagent_agents),
		cwd: frontmatter.cwd || undefined,
		denyTools: splitList(frontmatter["deny-tools"]),
		...(parseBoolean(frontmatter.spawning) !== undefined
			? { spawning: parseBoolean(frontmatter.spawning) }
			: {}),
		autoExit: parseBoolean(frontmatter["auto-exit"]),
		interactive: parseBoolean(frontmatter.interactive),
		disableModelInvocation: parseBoolean(frontmatter["disable-model-invocation"]),
	};
}

/** Tools that let a child create or control further subagent sessions. */
export const SPAWNING_TOOL_NAMES = [
	"subagent",
	"subagent_visible",
	"subagent_interrupt",
	"subagents_list",
	"subagent_resume",
] as const;

/** Resolve frontmatter controls into the exact child-tool deny list. */
export function resolveDeniedTools(agent: Pick<AgentConfig, "denyTools" | "spawning">): string[] {
	const denied = new Set(agent.denyTools ?? []);
	if (agent.spawning === false) {
		for (const tool of SPAWNING_TOOL_NAMES) denied.add(tool);
	}
	return [...denied].sort();
}

export function discoverAgents(options: DiscoverAgentsOptions): AgentConfig[] {
	const globalConfigDir = options.globalConfigDir
		?? process.env.PI_CODING_AGENT_DIR
		?? path.join(os.homedir(), ".pi", "agent");
	const sources: Array<{ dir: string; source: AgentSource }> = [
		{ dir: options.bundledDir, source: "bundled" },
		{ dir: path.join(globalConfigDir, "agents"), source: "global" },
		{ dir: path.join(options.projectCwd, ".pi", "agents"), source: "project" },
	];
	const discovered = new Map<string, AgentConfig>();

	for (const { dir, source } of sources) {
		if (!fs.existsSync(dir)) continue;
		for (const entry of fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
			const agent = parseAgentDefinition(
				path.join(dir, entry),
				source,
				options.modelOverrides,
			);
			if (agent) discovered.set(agent.name, agent);
		}
	}

	return [...discovered.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveAgentCwd(parentCwd: string, requestedCwd: string | undefined, agentCwd: string | undefined): string {
	return path.resolve(parentCwd, requestedCwd ?? agentCwd ?? ".");
}


