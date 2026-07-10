export type VisibleBackend = "herdr" | "tmux";

export interface HerdrPaneInfo {
	pane_id: string;
	cwd?: string | null;
	foreground_cwd?: string | null;
	focused?: boolean;
}

export interface DetectedVisibleTarget {
	backend: VisibleBackend;
	paneId?: string;
}

export interface VisibleTargetCandidates {
	preferredBackend?: VisibleBackend | null;
	herdrPaneId?: string | null;
	tmuxPaneId?: string | null;
}

export interface VisibleRunIdentity {
	id: string;
	name: string;
	agent: string;
}

export type VisibleRunLookup<T extends VisibleRunIdentity> =
	| { run: T; error?: never }
	| { run?: never; error: string };

export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildVisiblePaneLaunchCommand(scriptPath: string): string {
	return `bash ${shellEscape(scriptPath)}`;
}

export function buildTmuxVisibleSplitArgs(args: {
	anchorPaneId?: string | null;
	cwd: string;
	initialCommand?: string;
}): string[] {
	const splitArgs = ["tmux", "split-window", "-d", "-h"];
	if (args.anchorPaneId) splitArgs.push("-t", args.anchorPaneId);
	splitArgs.push("-c", args.cwd, "-P", "-F", "#{pane_id}");
	if (args.initialCommand) splitArgs.push(args.initialCommand);
	return splitArgs;
}

export function buildTmuxRemainOnExitArgs(paneId: string): string[] {
	return ["tmux", "set-option", "-pt", paneId, "remain-on-exit", "on"];
}

export function parseVisibleBackendPreference(raw: string | undefined): VisibleBackend | null {
	const value = raw?.trim().toLowerCase();
	if (value === "herdr" || value === "tmux") return value;
	return null;
}

export function chooseVisibleTarget(candidates: VisibleTargetCandidates): DetectedVisibleTarget | null {
	const herdrTarget = candidates.herdrPaneId
		? { backend: "herdr" as const, paneId: candidates.herdrPaneId }
		: null;
	const tmuxTarget = candidates.tmuxPaneId
		? { backend: "tmux" as const, paneId: candidates.tmuxPaneId }
		: null;

	if (candidates.preferredBackend === "herdr") return herdrTarget ?? tmuxTarget;
	if (candidates.preferredBackend === "tmux") return tmuxTarget ?? herdrTarget;
	return herdrTarget ?? tmuxTarget;
}

export function resolveVisibleRun<T extends VisibleRunIdentity>(
	runs: Iterable<T>,
	query: { id?: string; name?: string },
): VisibleRunLookup<T> {
	const allRuns = [...runs];
	if (query.id) {
		const run = allRuns.find((candidate) => candidate.id === query.id);
		return run ? { run } : { error: `No running visible subagent with id "${query.id}".` };
	}
	if (!query.name) return { error: "Provide either `id` or `name`." };

	const matches = allRuns.filter((candidate) => candidate.name === query.name || candidate.agent === query.name);
	if (matches.length === 1) return { run: matches[0] };
	if (matches.length === 0) return { error: `No running visible subagent named "${query.name}".` };
	return {
		error: `Ambiguous visible subagent name "${query.name}". Use one of these ids: ${matches.map((run) => run.id).join(", ")}.`,
	};
}

export function buildVisibleSubagentUserMessage(agentName: string, task: string): string {
	const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
	return `Use subagent_visible with agent: "${agentName}", task: ${JSON.stringify(taskText)}`;
}

export function parseHerdrPaneCurrent(raw: string): HerdrPaneInfo | null {
	try {
		const parsed = JSON.parse(raw) as {
			result?: { pane?: { pane_id?: unknown; cwd?: unknown; foreground_cwd?: unknown } };
		};
		const pane = parsed.result?.pane;
		if (!pane || typeof pane.pane_id !== "string" || !pane.pane_id) return null;
		return {
			pane_id: pane.pane_id,
			cwd: typeof pane.cwd === "string" ? pane.cwd : null,
			foreground_cwd: typeof pane.foreground_cwd === "string" ? pane.foreground_cwd : null,
			focused: typeof (pane as { focused?: unknown }).focused === "boolean"
				? (pane as { focused: boolean }).focused
				: undefined,
		};
	} catch {
		return null;
	}
}

export function isFocusedHerdrPane(pane: HerdrPaneInfo | null): boolean {
	return pane?.focused === true;
}

export function parseHerdrPaneSplit(raw: string): string | null {
	try {
		const parsed = JSON.parse(raw) as {
			result?: { pane?: { pane_id?: unknown } };
		};
		const paneId = parsed.result?.pane?.pane_id;
		return typeof paneId === "string" && paneId ? paneId : null;
	} catch {
		const match = raw.match(/\b[\w-]+:p[\w-]+\b/);
		return match?.[0] ?? null;
	}
}

export function parseHerdrTabCreate(raw: string): string | null {
	try {
		const parsed = JSON.parse(raw) as {
			result?: { tab?: { tab_id?: unknown } };
		};
		const tabId = parsed.result?.tab?.tab_id;
		return typeof tabId === "string" && tabId ? tabId : null;
	} catch {
		const match = raw.match(/\b[\w-]+:t[\w-]+\b/);
		return match?.[0] ?? null;
	}
}

export function pathLooksRelated(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function shouldUseHerdrForCwd(pane: HerdrPaneInfo | null, cwd: string): boolean {
	if (!pane) return false;
	return pathLooksRelated(pane.cwd, cwd) || pathLooksRelated(pane.foreground_cwd, cwd);
}

export function buildVisibleShellScript(args: {
	cwd: string;
	commandArgs: string[];
	exitFile: string;
	env?: Record<string, string | undefined>;
}): string {
	const command = args.commandArgs.map(shellEscape).join(" ");
	const envLines = Object.entries(args.env ?? {})
		.filter((entry): entry is [string, string] => typeof entry[1] === "string")
		.map(([key, value]) => `export ${key}=${shellEscape(value)}`);
	return [
		"#!/usr/bin/env bash",
		`cd ${shellEscape(args.cwd)}`,
		...envLines,
		command,
		"status=$?",
		`printf '%s\\n' \"$status\" > ${shellEscape(args.exitFile)}`,
		"exit \"$status\"",
	].join("\n");
}
