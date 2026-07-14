export interface AgentSpawnConfig {
	name: string;
	tools: string[];
	subagentAgents?: string[];
}

export interface SubagentEnvOverrides {
	PI_SUBAGENT_AGENT: string;
	PI_SUBAGENT_ALLOWED?: string;
}

export interface ParsedSubagentCommandArgs {
	agentName?: string;
	task: string;
}

export function parseSubagentCommandArgs(args: string): ParsedSubagentCommandArgs {
	const trimmed = args.trim();
	if (!trimmed) return { task: "" };
	const spaceIdx = trimmed.indexOf(" ");
	if (spaceIdx === -1) return { agentName: trimmed, task: "" };
	return {
		agentName: trimmed.slice(0, spaceIdx),
		task: trimmed.slice(spaceIdx + 1).trim(),
	};
}

export function buildSubagentUserMessage(agentName: string, task: string): string {
	const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
	return `Use subagent with agent: "${agentName}", task: ${JSON.stringify(taskText)}`;
}

export function getSelfSpawnError(currentAgent: string | undefined, requestedAgent: string | undefined): string | null {
	if (!currentAgent || !requestedAgent || currentAgent !== requestedAgent) return null;
	return `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`;
}

export function buildSubagentChildEnv(
	baseEnv: NodeJS.ProcessEnv,
	agent: AgentSpawnConfig,
): NodeJS.ProcessEnv {
	const overrides = buildSubagentEnvOverrides(agent);
	const env = { ...baseEnv, ...overrides };
	if (!("PI_SUBAGENT_ALLOWED" in overrides)) delete env.PI_SUBAGENT_ALLOWED;
	return env;
}

export function buildSubagentEnvOverrides(agent: AgentSpawnConfig): SubagentEnvOverrides {
	const overrides: SubagentEnvOverrides = {
		PI_SUBAGENT_AGENT: agent.name,
	};
	if (agent.tools.includes("subagent") && agent.subagentAgents && agent.subagentAgents.length > 0) {
		overrides.PI_SUBAGENT_ALLOWED = agent.subagentAgents.join(",");
	}
	return overrides;
}
