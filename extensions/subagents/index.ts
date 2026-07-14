/**
 * Subagents extension — nested delegation for pi.
 *
 * Registers a single `subagent` tool backed by markdown-defined agents
 * (agents/*.md). Supports single + parallel execution and bounded nesting:
 * an agent that carries the `subagent` tool may itself spawn children, but
 * only the agents listed in its `subagent_agents` frontmatter (passed down via
 * PI_SUBAGENT_ALLOWED). Each subagent runs as an isolated `pi --mode json`
 * process with NO inherited context.
 *
 * Adapted for the @earendil-works/pi fork:
 *   - imports normalized to @earendil-works/pi-coding-agent + typebox
 *   - parseFrontmatter implemented locally (no helper dependency)
 *   - CUSTOM_TOOL_EXTENSIONS resolved relative to this repo, not ~/.pi
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	discoverAgents,
	resolveDeniedTools,
	resolveAgentCwd,
	type AgentConfig,
} from "./agent-discovery.ts";
import {
	buildSubagentChildEnv,
	buildSubagentEnvOverrides,
	buildSubagentUserMessage,
	getSelfSpawnError,
	parseSubagentCommandArgs,
} from "./helpers.ts";
import {
	buildVisiblePaneLaunchCommand,
	resolveVisibleRun,
	type VisibleBackend,
} from "./visible-helpers.ts";
import {
	cleanupFailedVisibleLaunch,
	closeVisiblePane,
	createVisiblePane,
	detectVisibleTarget,
	makeVisibleRunFiles,
	readVisiblePane,
	readVisiblePing,
	readVisibleSessionSummary,
	sendVisibleEscape,
	tryReadVisibleExitCode,
	writeVisibleRunScript,
	launchVisibleRun,
	type VisibleRunFiles,
	type VisibleRunTarget,
} from "./visible-runtime.ts";

export type { AgentConfig } from "./agent-discovery.ts";

// ── Types ──────────────────────────────────────────────────────────────

interface ToolEvent {
	tool: string;
	args: string;
	toolCallId?: string;
	status: "running" | "done";
	children?: AgentResult[];
}

interface AgentProgress {
	agent: string;
	status: "pending" | "running" | "completed" | "failed";
	task: string;
	recentTools: ToolEvent[];
	toolCount: number;
	tokens: number;
	durationMs: number;
	lastMessage: string;
	error?: string;
}

interface AgentResult {
	agent: string;
	task: string;
	output: string;
	exitCode: number;
	progress: AgentProgress;
	model?: string;
	contextWindow?: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
}

interface Details {
	results: AgentResult[];
}

interface VisibleSubagentRun {
	id: string;
	name: string;
	agent: string;
	task: string;
	startTime: number;
	target: VisibleRunTarget;
	files: VisibleRunFiles;
	tempDir: string;
	model?: string;
	interactive: boolean;
	preserveSessionOnPing?: boolean;
	status: "running" | "interrupt_requested";
}

// ── Config ─────────────────────────────────────────────────────────────

interface ExtensionConfig {
	maxConcurrency?: number;
	/** Per-agent model override. Falls back to frontmatter `model` if absent. */
	models?: Record<string, string>;
}

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(EXT_DIR, "agents");
const TOOLS_DIR = path.join(EXT_DIR, "tools");
const CONFIG_PATH = path.join(EXT_DIR, "config.json");
const DEFAULT_MAX_CONCURRENCY = 4;

function loadConfig(): ExtensionConfig {
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as ExtensionConfig;
		}
	} catch {}
	return {};
}

// Built-in tools that pi provides natively (no extension needed)
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

// Custom tools that require loading an extension into the subagent process.
// Resolved relative to THIS repo so the child `pi --extension <path>` always
// points at the same on-disk files this parent loaded — no dependence on a
// global ~/.pi install layout.
const EXT_ROOT = path.join(EXT_DIR, "..");
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
	web_search: path.join(EXT_ROOT, "web-search", "index.ts"),
	web_fetch: path.join(EXT_ROOT, "web-fetch", "index.ts"),
	safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
	subagent_visible_auto_exit: path.join(TOOLS_DIR, "visible-auto-exit.ts"),
	// `subagent` is the tool this very extension registers. Listing it here lets
	// a parent agent grant it to a child agent — the child pi process loads this
	// same index.ts via `--extension`, sees its own subagent tool, and (if
	// PI_SUBAGENT_ALLOWED is set) only registers the allowlisted agents.
	subagent: path.join(EXT_DIR, "index.ts"),
};
const VISIBLE_CONTROL_TOOLS = ["caller_ping", "subagent_done"];

// ── Agent Discovery & Registration ────────────────────────────────────

let agents: AgentConfig[] = [];
const visibleSubagents = new Map<string, VisibleSubagentRun>();
let latestCtx: ExtensionContext | null = null;
let visibleWidgetInterval: ReturnType<typeof setInterval> | null = null;

// Read once at module load. If we're a child subagent process whose parent
// pinned an allowlist, we silently ignore any agent not in the list.
const SUBAGENT_ALLOWLIST: string[] | undefined = (() => {
	const raw = process.env.PI_SUBAGENT_ALLOWED;
	if (!raw) return undefined;
	const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
	return list.length > 0 ? list : undefined;
})();

export function registerAgent(config: AgentConfig): void {
	if (SUBAGENT_ALLOWLIST && !SUBAGENT_ALLOWLIST.includes(config.name)) return;
	if (agents.find((a) => a.name === config.name)) {
		throw new Error(`Agent already registered: ${config.name}`);
	}
	agents.push(config);
}

export function unregisterAgent(name: string): void {
	agents = agents.filter((a) => a.name !== name);
}

// Expose registration functions globally so other extensions loaded via jiti
// (which creates separate module instances) can access the shared agents array.
(globalThis as any).__pi_subagents = { registerAgent, unregisterAgent };

function loadAgents(config: ExtensionConfig, cwd: string = process.cwd()): AgentConfig[] {
	return discoverAgents({
		bundledDir: AGENTS_DIR,
		projectCwd: cwd,
		modelOverrides: config.models,
	});
}

// ── Pi Binary Resolution ──────────────────────────────────────────────

function resolvePiBinary(): { command: string; baseArgs: string[] } {
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = fs.realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {}
	}
	return { command: "pi", baseArgs: [] };
}

// `provider/modelId` where modelId may itself contain slashes
// (e.g. openrouter/z-ai/glm-5.1 → provider=openrouter, modelId=z-ai/glm-5.1).
function splitModel(model: string): { provider?: string; modelId?: string } {
	const i = model.indexOf("/");
	if (i < 0) return { modelId: model };
	return { provider: model.slice(0, i), modelId: model.slice(i + 1) };
}

// ── Formatting Utilities ──────────────────────────────────────────────

function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function formatElapsedMMSS(startTime: number): string {
	const seconds = Math.floor((Date.now() - startTime) / 1000);
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
	if (!contextWindow) return `${formatTokens(tokens)} ctx`;
	const pct = (tokens / contextWindow) * 100;
	const maxStr = contextWindow >= 1_000_000 ? `${(contextWindow / 1_000_000).toFixed(1)}M` : `${Math.round(contextWindow / 1000)}k`;
	return `${pct.toFixed(1)}%/${maxStr}`;
}

function truncLine(text: string, maxWidth: number): string {
	if (text.includes("\n") || text.includes("\r")) {
		text = text.replace(/\r?\n/g, "↵ ");
	}
	if (visibleWidth(text) <= maxWidth) return text;
	let result = "";
	let width = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\x1b") {
			const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (match) {
				result += match[0];
				i += match[0].length - 1;
				continue;
			}
		}
		if (width >= maxWidth - 1) {
			return result + "…";
		}
		result += ch;
		width++;
	}
	return result;
}

function widgetBorderTop(title: string, info: string, width: number, theme: Theme): string {
	if (width <= 1) return theme.fg("accent", "╭");
	const inner = Math.max(0, width - 2);
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const fill = "─".repeat(Math.max(0, inner - titlePart.length - infoPart.length));
	return theme.fg("accent", `╭${`${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─")}╮`);
}

function widgetBorderLine(left: string, right: string, width: number, theme: Theme): string {
	if (width <= 1) return theme.fg("accent", "│");
	const inner = Math.max(0, width - 2);
	const safeRight = truncLine(right, inner);
	const remaining = Math.max(0, inner - visibleWidth(safeRight));
	const safeLeft = truncLine(left, remaining);
	const padding = " ".repeat(Math.max(0, inner - visibleWidth(safeLeft) - visibleWidth(safeRight)));
	return `${theme.fg("accent", "│")}${safeLeft}${padding}${safeRight}${theme.fg("accent", "│")}`;
}

function widgetBorderBottom(width: number, theme: Theme): string {
	if (width <= 1) return theme.fg("accent", "╰");
	return theme.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function renderVisibleWidgetLines(runs: VisibleSubagentRun[], width: number, theme: Theme): string[] {
	const lines = [widgetBorderTop("Visible Subagents", `${runs.length} running`, width, theme)];
	for (const run of runs) {
		const elapsed = formatElapsedMMSS(run.startTime);
		const left = ` ${elapsed}  ${theme.fg("toolTitle", theme.bold(run.name))} ${theme.fg("dim", `(${run.agent})`)} `;
		const mode = run.interactive ? "interactive" : "autonomous";
		const state = run.status === "interrupt_requested" ? "interrupt requested" : "running";
		const right = theme.fg(run.status === "interrupt_requested" ? "warning" : "success", ` ${state} · ${mode} · ${run.target.backend} `);
		lines.push(widgetBorderLine(left, right, width, theme));
	}
	lines.push(widgetBorderBottom(width, theme));
	return lines;
}

function updateVisibleWidget() {
	if (!latestCtx?.hasUI || typeof (latestCtx.ui as any)?.setWidget !== "function") return;
	if (visibleSubagents.size === 0) {
		(latestCtx.ui as any).setWidget("subagent-visible-status", undefined);
		if (visibleWidgetInterval) {
			clearInterval(visibleWidgetInterval);
			visibleWidgetInterval = null;
		}
		return;
	}
	(latestCtx.ui as any).setWidget(
		"subagent-visible-status",
		(_tui: unknown, theme: Theme) => {
			const runs = Array.from(visibleSubagents.values());
			return {
				invalidate() {},
				render(width: number) {
					return renderVisibleWidgetLines(runs, width, theme);
				},
			};
		},
		{ placement: "aboveEditor" },
	);
}

function ensureVisibleWidgetTimer() {
	if (visibleWidgetInterval) return;
	visibleWidgetInterval = setInterval(() => updateVisibleWidget(), 1000);
}

// ── Subagent Execution ────────────────────────────────────────────────

async function buildPiArgs(
	agent: AgentConfig,
	task: string,
	mode: "json" | "text" = "json",
): Promise<{ args: string[]; tempDir: string; childEnv: NodeJS.ProcessEnv | undefined }> {
	const piBin = resolvePiBinary();
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sub-"));

	const promptPath = path.join(tempDir, `${agent.name}.md`);
	await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });

	const args = [...piBin.baseArgs, "--mode", mode, "-p", "--no-session", "--no-skills"];

	const allowlist: string[] = [];
	const extensionPaths = new Set<string>();
	const deniedTools = new Set(resolveDeniedTools(agent));

	for (const tool of agent.tools) {
		if (deniedTools.has(tool)) continue;
		if (BUILTIN_TOOLS.has(tool)) {
			allowlist.push(tool);
		} else if (CUSTOM_TOOL_EXTENSIONS[tool]) {
			allowlist.push(tool);
			extensionPaths.add(CUSTOM_TOOL_EXTENSIONS[tool]);
		}
	}

	args.push("--no-extensions");

	if (allowlist.length > 0) {
		args.push("--tools", allowlist.join(","));
	} else {
		args.push("--no-tools");
	}

	for (const extPath of extensionPaths) {
		args.push("--extension", extPath);
	}

	args.push("--models", agent.model);
	args.push("--thinking", agent.thinking);
	args.push("--append-system-prompt", promptPath);

	const TASK_LIMIT = 8000;
	if (task.length > TASK_LIMIT) {
		const taskPath = path.join(tempDir, "task.md");
		await fs.promises.writeFile(taskPath, `Task: ${task}`, { encoding: "utf-8", mode: 0o600 });
		args.push(`@${taskPath}`);
	} else {
		args.push(`Task: ${task}`);
	}

	const childEnv = buildSubagentChildEnv(process.env, agent);

	return { args: [piBin.command, ...args], tempDir, childEnv };
}

function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

function flatten(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

const MAX_ARG_PREVIEW = 4000;

function extractToolArgsPreview(args: Record<string, unknown>): string {
	const cap = (s: string) => (s.length > MAX_ARG_PREVIEW ? s.slice(0, MAX_ARG_PREVIEW) + "…" : s);
	if (args.command) return cap(flatten(String(args.command)));
	if (args.path) return cap(flatten(String(args.path)));
	if (args.query) return `"${cap(flatten(String(args.query)))}"`;
	if (args.url) return cap(flatten(String(args.url)));
	if (args.pattern) return cap(flatten(String(args.pattern)));
	if (args.agent) return flatten(String(args.agent));
	if (Array.isArray(args.tasks)) {
		const names = (args.tasks as Array<{ agent?: string }>)
			.map((t) => t?.agent || "?")
			.join(", ");
		return `parallel(${names})`;
	}
	return cap(flatten(JSON.stringify(args)));
}

async function runSubagent(
	agent: AgentConfig,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (progress: AgentProgress, usage: AgentResult["usage"]) => void,
): Promise<AgentResult> {
	const { args, tempDir, childEnv } = await buildPiArgs(agent, task);
	const command = args[0];
	const spawnArgs = args.slice(1);

	const result: AgentResult = {
		agent: agent.name,
		task,
		output: "",
		exitCode: 0,
		model: agent.model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		progress: {
			agent: agent.name,
			status: "running",
			task,
			recentTools: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
			lastMessage: "",
		},
	};

	const startTime = Date.now();
	const progress = result.progress;

	const fireUpdate = throttle(() => {
		progress.durationMs = Date.now() - startTime;
		onUpdate?.(progress, result.usage);
	}, 150);

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(command, spawnArgs, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			...(childEnv ? { env: childEnv } : {}),
		});

		let buf = "";
		let stderrBuf = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const evt = JSON.parse(line) as any;
				progress.durationMs = Date.now() - startTime;

				if (evt.type === "tool_execution_start") {
					progress.toolCount++;
					progress.recentTools.push({
						tool: evt.toolName,
						args: extractToolArgsPreview((evt.args || {}) as Record<string, unknown>),
						toolCallId: evt.toolCallId,
						status: "running",
					});
					fireUpdate();
				}

				if (evt.type === "tool_execution_update") {
					const partial = evt.partialResult as { details?: { results?: unknown } } | undefined;
					const nested = partial?.details?.results;
					if (evt.toolName === "subagent" && Array.isArray(nested) && evt.toolCallId) {
						const hit = progress.recentTools.find((t) => t.toolCallId === evt.toolCallId);
						if (hit) {
							hit.children = nested as AgentResult[];
							fireUpdate();
						}
					}
				}

				if (evt.type === "tool_execution_end") {
					const hit = evt.toolCallId
						? progress.recentTools.find((t) => t.toolCallId === evt.toolCallId)
						: undefined;
					if (hit) {
						hit.status = "done";
						const finalResult = evt.result as { details?: { results?: unknown } } | undefined;
						const finalChildren = finalResult?.details?.results;
						if (evt.toolName === "subagent" && Array.isArray(finalChildren)) {
							hit.children = finalChildren as AgentResult[];
						}
					}
					fireUpdate();
				}

				if (evt.type === "tool_result_end") {
					fireUpdate();
				}

				if (evt.type === "message_end" && evt.message) {
					if (evt.message.role === "assistant") {
						result.usage.turns++;
						const u = evt.message.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							progress.tokens = (u as { totalTokens?: number }).totalTokens
								|| (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
						}
						if (evt.message.model) result.model = evt.message.model;
						if (evt.message.errorMessage) progress.error = evt.message.errorMessage;

						const text = extractTextFromContent(evt.message.content);
						if (text) {
							result.output = text;
							const proseLines: string[] = [];
							let inCodeBlock = false;
							for (const line of text.split("\n")) {
								if (line.trimStart().startsWith("```")) {
									inCodeBlock = !inCodeBlock;
									continue;
								}
								if (!inCodeBlock && line.trim()) {
									proseLines.push(line.trim());
								}
							}
							if (proseLines.length > 0) {
								progress.lastMessage = proseLines.slice(0, 3).join(" ");
							}
						}
					}

					fireUpdate();
				}
			} catch {
				// Non-JSON lines are expected
			}
		};

		proc.stdout.on("data", (d: Buffer) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});

		proc.stderr.on("data", (d: Buffer) => {
			stderrBuf += d.toString();
		});

		proc.on("close", (code) => {
			if (buf.trim()) processLine(buf);
			if (code !== 0 && stderrBuf.trim() && !progress.error) {
				progress.error = stderrBuf.trim();
			}
			resolve(code ?? 1);
		});

		proc.on("error", () => resolve(1));

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {}

	result.exitCode = exitCode;
	progress.status = exitCode === 0 && !progress.error ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	if (progress.error) result.output = result.output || `Error: ${progress.error}`;

	if (result.output.length > DEFAULT_MAX_BYTES) {
		const trunc = truncateHead(result.output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		result.output = trunc.content;
		if (trunc.truncated) {
			result.output += "\n\n[Output truncated]";
		}
	}

	return result;
}

async function launchVisibleSubagent(
	pi: ExtensionAPI,
	agent: AgentConfig,
	task: string,
	cwd: string,
): Promise<VisibleSubagentRun> {
	const detected = detectVisibleTarget(cwd);
	if (!detected) {
		throw new Error("Visible subagent mode requires a supported live mux target (Herdr or tmux).");
	}

	const id = Math.random().toString(16).slice(2, 10);
	const interactive = !(agent.autoExit ?? false);
	const piBin = resolvePiBinary();
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sub-"));
	let target: VisibleRunTarget | null = null;
	try {
		const promptPath = path.join(tempDir, `${agent.name}.md`);
		const taskPath = path.join(tempDir, "task.md");
		await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
		await fs.promises.writeFile(
			taskPath,
			interactive
				? `${task}\n\nWork on this task in the visible pane. The user may continue the conversation with you here. When you have completed the task, give your final concise report and call the subagent_done tool so this pane can close cleanly.`
				: `${task}\n\nComplete your task autonomously. Your final assistant message should summarize what you accomplished.`,
			{ encoding: "utf-8", mode: 0o600 },
		);
		const files = makeVisibleRunFiles(tempDir);
		const allowlist: string[] = [];
		const extensionPaths = new Set<string>([CUSTOM_TOOL_EXTENSIONS.subagent_visible_auto_exit]);
		const deniedTools = new Set(resolveDeniedTools(agent));
		for (const tool of agent.tools) {
			if (deniedTools.has(tool)) continue;
			if (BUILTIN_TOOLS.has(tool)) {
				allowlist.push(tool);
			} else if (CUSTOM_TOOL_EXTENSIONS[tool]) {
				allowlist.push(tool);
				extensionPaths.add(CUSTOM_TOOL_EXTENSIONS[tool]);
			}
		}
		// These lifecycle tools come from visible-auto-exit.ts and must remain
		// usable even when the agent's own allowlist is deliberately narrow.
		allowlist.push(...VISIBLE_CONTROL_TOOLS);
		const args = [...piBin.baseArgs, "--no-skills", "--no-extensions"];
		if (interactive) args.push("--session", files.sessionFile, "--name", `${agent.name}:${id}`);
		else args.push("--no-session");
		if (allowlist.length > 0) args.push("--tools", allowlist.join(","));
		else args.push("--no-tools");
		for (const extPath of extensionPaths) {
			args.push("--extension", extPath);
		}
		args.push("--models", agent.model);
		args.push("--thinking", agent.thinking);
		args.push("--append-system-prompt", promptPath);
		args.push(`@${taskPath}`);

		const env = {
			...buildSubagentEnvOverrides(agent),
			PI_SUBAGENT_NAME: `${agent.name}:${id}`,
			PI_DENY_TOOLS: [...deniedTools].join(","),
			PI_SUBAGENT_AUTO_EXIT: interactive ? "0" : "1",
			PI_VISIBLE_SUBAGENT_EXIT_FILE: files.exitFile,
			PI_VISIBLE_SUBAGENT_PING_FILE: files.pingFile,
		};
		writeVisibleRunScript(files, cwd, args, env);

		const initialCommand = detected.backend === "tmux"
			? buildVisiblePaneLaunchCommand(files.scriptPath)
			: undefined;
		target = createVisiblePane(detected, cwd, `${agent.name}:${id}`, initialCommand);
		launchVisibleRun(target, files);

		const run: VisibleSubagentRun = {
			id,
			name: `${agent.name}:${id}`,
			agent: agent.name,
			task,
			startTime: Date.now(),
			target,
			files,
			tempDir,
			model: agent.model,
			interactive,
			status: "running",
		};
		visibleSubagents.set(id, run);
		updateVisibleWidget();
		ensureVisibleWidgetTimer();
		startVisibleSubagentWatcher(pi, run);
		return run;
	} catch (error) {
		visibleSubagents.delete(id);
		cleanupFailedVisibleLaunch(tempDir, target);
		throw error;
	}
}

async function resumeVisibleSubagent(
	pi: ExtensionAPI,
	params: { sessionPath: string; name?: string; agent?: string; message: string; autoExit?: boolean },
	cwd: string,
): Promise<VisibleSubagentRun> {
	if (!fs.existsSync(params.sessionPath)) {
		throw new Error(`Subagent session not found: ${params.sessionPath}`);
	}
	const detected = detectVisibleTarget(cwd);
	if (!detected) throw new Error("subagent_resume requires a supported live mux target (Herdr or tmux).");

	const id = Math.random().toString(16).slice(2, 10);
	const name = params.name?.trim() || "Resume";
	const agent = params.agent?.trim() || "resume";
	const autoExit = params.autoExit ?? true;
	const piBin = resolvePiBinary();
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sub-resume-"));
	const files = makeVisibleRunFiles(tempDir);
	const args = [
		...piBin.baseArgs,
		"--no-skills",
		"--no-extensions",
		"--session",
		params.sessionPath,
		"--extension",
		CUSTOM_TOOL_EXTENSIONS.subagent_visible_auto_exit,
		params.message,
	];
	const env = {
		PI_SUBAGENT_AGENT: agent,
		PI_SUBAGENT_NAME: `${name}:${id}`,
		PI_SUBAGENT_AUTO_EXIT: autoExit ? "1" : "0",
		PI_VISIBLE_SUBAGENT_EXIT_FILE: files.exitFile,
		PI_VISIBLE_SUBAGENT_PING_FILE: files.pingFile,
	};
	writeVisibleRunScript(files, cwd, args, env);

	const initialCommand = detected.backend === "tmux"
		? buildVisiblePaneLaunchCommand(files.scriptPath)
		: undefined;
	const target = createVisiblePane(detected, cwd, `${name}:${id}`, initialCommand);
	launchVisibleRun(target, files);

	const run: VisibleSubagentRun = {
		id,
		name: `${name}:${id}`,
		agent,
		task: params.message,
		startTime: Date.now(),
		target,
		files: { ...files, sessionFile: params.sessionPath },
		tempDir,
		interactive: !autoExit,
		status: "running",
	};
	visibleSubagents.set(id, run);
	updateVisibleWidget();
	ensureVisibleWidgetTimer();
	startVisibleSubagentWatcher(pi, run);
	return run;
}

function startVisibleSubagentWatcher(pi: ExtensionAPI, run: VisibleSubagentRun): void {
	void (async () => {
		try {
			while (true) {
				const exitCode = tryReadVisibleExitCode(run.files.exitFile);
				if (exitCode !== null) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}

			const exitCode = tryReadVisibleExitCode(run.files.exitFile) ?? 1;
			const ping = readVisiblePing(run.files.pingFile);
			let output = readVisibleSessionSummary(run.files.sessionFile) ?? readVisiblePane(run.target, 200).trim();
			if (ping) output = `Help requested: ${ping}${output ? `\n\n${output}` : ""}`;
			if (output.length > DEFAULT_MAX_BYTES) {
				const trunc = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				output = trunc.content + (trunc.truncated ? "\n\n[Output truncated]" : "");
			}
			const elapsed = formatElapsedMMSS(run.startTime);
			try {
				closeVisiblePane(run.target);
			} catch {}
			visibleSubagents.delete(run.id);
			updateVisibleWidget();
			if (!ping) {
				try {
					fs.rmSync(run.tempDir, { recursive: true, force: true });
				} catch {}
			}

			if (typeof (pi as any).sendMessage === "function") {
				(pi as any).sendMessage(
					{
						customType: "subagent_visible_result",
						content:
							`Visible subagent "${run.name}" ${exitCode === 0 ? "completed" : `failed (exit ${exitCode})`} (${elapsed}).` +
							(output ? `\n\n${output}` : ""),
						display: true,
						details: {
							name: run.name,
							agent: run.agent,
							elapsed,
							exitCode,
							backend: run.target.backend,
							paneId: run.target.paneId,
							ping,
							sessionPath: ping ? run.files.sessionFile : undefined,
						},
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			}
		} catch (error) {
			try {
				closeVisiblePane(run.target);
			} catch {}
			visibleSubagents.delete(run.id);
			updateVisibleWidget();
			try {
				fs.rmSync(run.tempDir, { recursive: true, force: true });
			} catch {}
			if (typeof (pi as any).sendMessage === "function") {
				(pi as any).sendMessage(
					{
						customType: "subagent_visible_result",
						content: `Visible subagent "${run.name}" error: ${error instanceof Error ? error.message : String(error)}`,
						display: true,
						details: {
							name: run.name,
							agent: run.agent,
							elapsed: formatElapsedMMSS(run.startTime),
							exitCode: 1,
							backend: run.target.backend,
							paneId: run.target.paneId,
						},
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			}
		}
	})();
}

// ── Throttle ──────────────────────────────────────────────────────────

function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
	let lastCall = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return ((...args: any[]) => {
		const now = Date.now();
		const remaining = ms - (now - lastCall);
		if (remaining <= 0) {
			lastCall = now;
			if (timer) { clearTimeout(timer); timer = undefined; }
			fn(...args);
		} else if (!timer) {
			timer = setTimeout(() => {
				lastCall = Date.now();
				timer = undefined;
				fn(...args);
			}, remaining);
		}
	}) as T;
}

// ── Parallel Execution with Concurrency Limit ─────────────────────────

class Semaphore {
	private inFlight = 0;
	private readonly waiters: Array<() => void> = [];
	constructor(private readonly max: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.inFlight >= this.max) {
			await new Promise<void>((r) => this.waiters.push(r));
		}
		this.inFlight++;
		try {
			return await fn();
		} finally {
			this.inFlight--;
			const next = this.waiters.shift();
			if (next) next();
		}
	}
}

// ── Rendering ─────────────────────────────────────────────────────────

type Theme = ExtensionContext["ui"]["theme"];

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function renderAgentProgress(
	r: AgentResult,
	theme: Theme,
	expanded: boolean,
	w: number,
	depth: number = 0,
): Container {
	const c = new Container();
	const prog = r.progress;
	const isRunning = prog.status === "running";
	const isPending = prog.status === "pending";
	const nested = depth > 0;

	const indent = nested ? "  ".repeat(depth) : "";
	const innerW = Math.max(20, w - indent.length);

	const addLine = (content: string) => {
		if (expanded) {
			c.addChild(new Text(indent + content, 0, 0));
		} else {
			c.addChild(new Text(indent + truncLine(content, innerW), 0, 0));
		}
	};

	const icon = isRunning
		? theme.fg("warning", "⟳")
		: isPending
			? theme.fg("dim", "○")
			: r.exitCode === 0
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
	const stats = `${prog.toolCount} tools · ${formatDuration(prog.durationMs)}`;
	const modelStr = r.model ? theme.fg("dim", ` (${r.model})`) : "";
	addLine(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelStr} — ${theme.fg("dim", stats)}`);

	const renderToolRow = (
		toolName: string,
		toolArgs: string,
		children: AgentResult[] | undefined,
		isCurrent: boolean,
	) => {
		const body = toolArgs ? `${toolName}: ${toolArgs}` : toolName;
		if (isCurrent) {
			addLine(theme.fg("warning", `▸ ${body}`));
		} else {
			addLine(theme.fg("muted", `  ${body}`));
		}
		if (children && children.length > 0) {
			for (const child of children) {
				c.addChild(renderAgentProgress(child, theme, expanded, w, depth + 1));
			}
		}
	};

	for (const t of prog.recentTools) {
		renderToolRow(t.tool, t.args, t.children, t.status === "running");
	}

	if (prog.lastMessage) {
		if (!nested) c.addChild(new Spacer(1));
		addLine(theme.fg("text", prog.lastMessage));
	}

	if (!nested && !isRunning && r.output && expanded) {
		c.addChild(new Spacer(1));
		addLine(theme.fg("text", r.output));
	}

	if (!nested) c.addChild(new Spacer(1));
	const usageParts: string[] = [];
	if (r.usage.input) usageParts.push(theme.fg("dim", `↑${formatTokens(r.usage.input)}`));
	if (r.usage.output) usageParts.push(theme.fg("dim", `↓${formatTokens(r.usage.output)}`));
	if (r.usage.cacheRead) usageParts.push(theme.fg("dim", `R${formatTokens(r.usage.cacheRead)}`));
	if (r.usage.cacheWrite) usageParts.push(theme.fg("dim", `W${formatTokens(r.usage.cacheWrite)}`));
	if (r.usage.cost) usageParts.push(theme.fg("dim", `$${r.usage.cost.toFixed(3)}`));
	if (prog.tokens > 0) {
		const ctxStr = formatContextUsage(prog.tokens, r.contextWindow);
		const pct = r.contextWindow ? (prog.tokens / r.contextWindow) * 100 : 0;
		const coloredCtx = pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
		usageParts.push(coloredCtx);
	}
	if (usageParts.length) {
		addLine(usageParts.join(" "));
	}

	if (prog.error) {
		addLine(theme.fg("error", `Error: ${prog.error}`));
	}

	return c;
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const semaphore = new Semaphore(config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
	const refreshAgents = (cwd: string): AgentConfig[] => {
		agents = loadAgents(config, cwd);
		if (SUBAGENT_ALLOWLIST) {
			agents = agents.filter((agent) => SUBAGENT_ALLOWLIST.includes(agent.name));
		}
		return agents;
	};
	refreshAgents(process.cwd());

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run a subagent to complete a task. Subagents have NO context from the current conversation — include all necessary context in the task description. " +
			"Available agents: " + (agents.map((a) => `${a.name} (${a.description})`).join("; ") || "none"),
		promptSnippet: "Run subagents for delegated tasks",
		promptGuidelines: [
			"Parallel tool calls are your primary parallelism mechanism — put multiple independent read/fetch/search calls in one tool-call block. Don't use subagents to parallelize simple I/O.",
			"Use subagent to delegate *reasoning and decisions*: codebase exploration (scout), web research (researcher), or isolated code changes (worker).",
			"For multiple independent subagent tasks, emit multiple `subagent` tool calls in the same turn — they run in parallel automatically (capped at maxConcurrency).",
			"Subagents have NO context from the current conversation — include ALL necessary context in the task description.",
			"When the user explicitly asks you to start or spawn agents, call `subagent` directly. Do not narrate skill selection, planning, or that you are 'about to dispatch parallel agents'.",
		],
		parameters: Type.Object({
			agent: Type.String({ description: "Name of the agent to invoke" }),
			task: Type.String({ description: "Task description (self-contained — the subagent sees nothing else)" }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.agent || !params.task) {
				throw new Error("`subagent` requires both `agent` and `task`. To fan out work, emit multiple `subagent` tool calls in the same turn — they run in parallel.");
			}

			const agent = agents.find((a) => a.name === params.agent);
			if (!agent) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				throw new Error(`Unknown agent: ${params.agent}. Available agents: ${available}`);
			}

			const selfSpawnError = getSelfSpawnError(process.env.PI_SUBAGENT_AGENT, params.agent);
			if (selfSpawnError) {
				return {
					content: [{ type: "text", text: selfSpawnError }],
					details: { error: "self-spawn blocked" },
					isError: true,
				};
			}

			const { provider, modelId } = splitModel(agent.model || "");
			const registry = (ctx as any).modelRegistry;
			const contextWindow = provider && modelId && registry?.find
				? registry.find(provider, modelId)?.contextWindow
				: undefined;

			const liveResult: AgentResult = {
				agent: params.agent,
				task: params.task,
				output: "",
				exitCode: -1,
				model: agent.model,
				contextWindow,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				progress: { agent: params.agent, status: "running" as const, task: params.task, recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "" },
			};

			const result = await semaphore.run(() =>
				runSubagent(
					agent,
					params.task!,
					resolveAgentCwd(ctx.cwd, params.cwd, agent.cwd),
					signal,
					(progress, usage) => {
					liveResult.progress = progress;
					liveResult.usage = { ...usage };
					onUpdate?.({
						content: [{ type: "text", text: "(running...)" }],
						details: { results: [liveResult] },
					});
					},
				),
			);

			result.contextWindow = contextWindow;
			const isError = result.exitCode !== 0 || !!result.progress.error;
			return {
				content: [{ type: "text", text: result.output || "(no output)" }],
				details: { results: [result] },
				...(isError ? { isError: true } : {}),
			};
		},

		renderCall(args, theme, context) {
			if (!context.expanded) {
				if (!args.agent) {
					return new Text(theme.fg("toolTitle", theme.bold("subagent")), 0, 0);
				}
				const taskPreview = args.task
					? (args.task.length > 60 ? args.task.slice(0, 60) + "…" : args.task).replace(/\n/g, " ")
					: "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent)} ${theme.fg("dim", taskPreview)}`,
					0, 0,
				);
			}

			const c = context.lastComponent instanceof Container
				? (context.lastComponent.clear(), context.lastComponent)
				: new Container();
			const agentLabel = args.agent ? ` ${theme.fg("accent", args.agent)}` : "";
			const cwdLabel = args.cwd ? theme.fg("dim", ` (cwd: ${args.cwd})`) : "";
			c.addChild(new Text(`${theme.fg("toolTitle", theme.bold("subagent"))}${agentLabel}${cwdLabel}`, 0, 0));
			if (args.task) {
				c.addChild(new Spacer(1));
				c.addChild(new Text(theme.fg("text", args.task), 0, 0));
			}
			return c;
		},

		renderResult(result, options, theme, context) {
			const details = result.details as Details | undefined;
			if (!details?.results?.length) {
				const t = result.content[0];
				const text = t?.type === "text" ? t.text : "(no output)";
				return new Text(text.slice(0, 200), 0, 0);
			}

			const w = getTermWidth() - 4;
			const expanded = options.expanded;
			const c = new Container();
			for (const agentResult of details.results) {
				const failed = agentResult.exitCode !== 0 || agentResult.progress.status === "failed";
				const box = new Box(1, 1, (text: string) => theme.bg(failed ? "toolErrorBg" : "toolSuccessBg", text));
				box.addChild(renderAgentProgress(agentResult, theme, expanded, w - 2));
				c.addChild(box);
				if (details.results.length > 1) c.addChild(new Spacer(1));
			}
			return c;
			},
		});

		pi.registerCommand("subagent", {
			description: "Spawn a subagent: /subagent <agent> <task>",
			handler: async (args, ctx) => {
				const parsed = parseSubagentCommandArgs(args);
				if (!parsed.agentName) {
					ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
					return;
				}

				const agent = agents.find((item) => item.name === parsed.agentName);
				if (!agent) {
					const available = agents.map((item) => item.name).join(", ") || "none";
					ctx.ui.notify(`Unknown agent: ${parsed.agentName}. Available agents: ${available}`, "error");
					return;
				}

				const selfSpawnError = getSelfSpawnError(process.env.PI_SUBAGENT_AGENT, parsed.agentName);
				if (selfSpawnError) {
					ctx.ui.notify(selfSpawnError, "warning");
					return;
				}

				pi.sendUserMessage(buildSubagentUserMessage(parsed.agentName, parsed.task));
			},
		});

		pi.registerTool({
			name: "subagent_visible",
			label: "Visible Subagent",
			description:
				"Spawn a visible subagent in a Herdr/tmux pane. This returns immediately; the pane runs in the background and the result is delivered back later.",
			promptSnippet: "Spawn a visible background subagent in a Herdr/tmux pane",
			promptGuidelines: [
				"Use this only when a visible live pane is useful. For ordinary delegated work, prefer `subagent`.",
				"This tool returns immediately. Do not invent results after calling it; wait for the later completion message.",
				"Agent definitions with `auto-exit: true` run autonomously and close after their final answer. When omitted or false, the pane stays open for interaction and the agent must call `subagent_done`.",
				"For multiple independent visible tasks, emit multiple `subagent_visible` tool calls in the same turn.",
				"When the user explicitly asks for visible agents, call `subagent_visible` directly without narrating skill selection or planning.",
			],
			parameters: Type.Object({
				agent: Type.String({ description: "Name of the agent to invoke" }),
				task: Type.String({ description: "Task description (self-contained — the subagent sees nothing else)" }),
				cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!params.agent || !params.task) {
					throw new Error("`subagent_visible` requires both `agent` and `task`.");
				}

				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const available = agents.map((a) => a.name).join(", ") || "none";
					throw new Error(`Unknown agent: ${params.agent}. Available agents: ${available}`);
				}

				const selfSpawnError = getSelfSpawnError(process.env.PI_SUBAGENT_AGENT, params.agent);
				if (selfSpawnError) {
					return {
						content: [{ type: "text", text: selfSpawnError }],
						details: { error: "self-spawn blocked" },
						isError: true,
					};
				}

				const cwd = resolveAgentCwd(ctx.cwd, params.cwd, agent.cwd);
				const run = await launchVisibleSubagent(pi, agent, params.task, cwd);
				return {
					content: [{
						type: "text",
						text: `Started ${run.interactive ? "interactive" : "autonomous"} visible subagent "${run.name}" in ${run.target.backend} pane ${run.target.paneId}.`,
					}],
					details: {
						id: run.id,
						name: run.name,
						agent: run.agent,
						backend: run.target.backend,
						paneId: run.target.paneId,
						interactive: run.interactive,
						status: "started",
					},
				};
			},
			renderCall(args, theme) {
				const agent = args.agent ? theme.fg("accent", String(args.agent)) : "(unknown)";
				const task = typeof args.task === "string" ? args.task.replace(/\n/g, " ") : "";
				const preview = task.length > 80 ? `${task.slice(0, 80)}…` : task;
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent_visible"))} ${agent} ${theme.fg("dim", preview)}`,
					0,
					0,
				);
			},
			renderResult(result, _options, theme) {
				const details = result.details as { name?: string; backend?: VisibleBackend; paneId?: string; interactive?: boolean; status?: string } | undefined;
				if (details?.status === "started") {
					const mode = details.interactive ? "interactive" : "autonomous";
					return new Text(
						`${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(details.name ?? "subagent"))} ${theme.fg("dim", `— ${mode} · ${details.backend}:${details.paneId}`)}`,
						0,
						0,
					);
				}
				const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
				return new Text(text, 0, 0);
			},
		});

		pi.registerCommand("subagent-visible", {
			description: "Spawn a visible subagent: /subagent-visible <agent> <task>",
			handler: async (args, ctx) => {
				const parsed = parseSubagentCommandArgs(args);
				if (!parsed.agentName) {
					ctx.ui.notify("Usage: /subagent-visible <agent> [task]", "warning");
					return;
				}

				const agent = agents.find((item) => item.name === parsed.agentName);
				if (!agent) {
					const available = agents.map((item) => item.name).join(", ") || "none";
					ctx.ui.notify(`Unknown agent: ${parsed.agentName}. Available agents: ${available}`, "error");
					return;
				}

				const selfSpawnError = getSelfSpawnError(process.env.PI_SUBAGENT_AGENT, parsed.agentName);
				if (selfSpawnError) {
					ctx.ui.notify(selfSpawnError, "warning");
					return;
				}

				const taskText = parsed.task || `You are the ${parsed.agentName} agent. Wait for instructions.`;
				const cwd = resolveAgentCwd(ctx.cwd, undefined, agent.cwd);
				const run = await launchVisibleSubagent(pi, agent, taskText, cwd);
				ctx.ui.notify(`Started ${run.interactive ? "interactive" : "autonomous"} visible subagent "${run.name}" in ${run.target.backend} pane ${run.target.paneId}.`, "info");
			},
		});

		pi.registerTool({
			name: "subagents_list",
			label: "List Subagents",
			description:
				"List available subagent definitions. Discovery precedence is project .pi/agents, then global ~/.pi/agent/agents, then bundled agents.",
			promptSnippet: "List available subagent definitions before delegating when the agent name is uncertain",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const listed = refreshAgents(ctx.cwd).filter((agent) => !agent.disableModelInvocation);
				if (listed.length === 0) {
					return {
						content: [{ type: "text", text: "No subagent definitions found." }],
						details: { agents: [] },
					};
				}
				const lines = listed.map((agent) => {
					const source = agent.source ? ` (${agent.source})` : "";
					const model = agent.model ? ` [${agent.model}]` : "";
					const description = agent.description ? ` — ${agent.description}` : "";
					return `${agent.name}${source}${model}${description}`;
				});
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { agents: listed },
				};
			},
			renderResult(result, _options, theme) {
				const listed = (result.details as { agents?: AgentConfig[] } | undefined)?.agents ?? [];
				if (listed.length === 0) return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
				const lines = listed.map((agent) => {
					const source = agent.source ? theme.fg("accent", ` (${agent.source})`) : "";
					const model = agent.model ? theme.fg("dim", ` [${agent.model}]`) : "";
					const description = agent.description ? theme.fg("dim", ` — ${agent.description}`) : "";
					return `${theme.fg("toolTitle", theme.bold(agent.name))}${source}${model}${description}`;
				});
				return new Text(lines.join("\n"), 0, 0);
			},
		});

		pi.registerTool({
			name: "subagent_resume",
			label: "Resume Subagent",
			description: "Resume a visible subagent session after caller_ping with a follow-up instruction.",
			promptSnippet: "Resume a subagent session that requested help",
			parameters: Type.Object({
				sessionPath: Type.String({ description: "Session path returned by caller_ping" }),
				message: Type.String({ description: "Parent guidance for the resumed child" }),
				name: Type.Optional(Type.String({ description: "Display name for the resumed pane" })),
				agent: Type.Optional(Type.String({ description: "Original agent role, used for display only" })),
				autoExit: Type.Optional(Type.Boolean({ description: "Close after the next normal turn; defaults to true" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const run = await resumeVisibleSubagent(pi, params, ctx.cwd);
				return {
					content: [{ type: "text", text: `Resumed visible subagent "${run.name}" in ${run.target.backend} pane ${run.target.paneId}.` }],
					details: { id: run.id, name: run.name, agent: run.agent, sessionPath: params.sessionPath, status: "started" },
				};
			},
			renderCall(args, theme) {
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent_resume"))} ${theme.fg("accent", String(args.name ?? "resume"))}`,
					0,
					0,
				);
			},
			renderResult(result, _options, theme) {
				const details = result.details as { name?: string; status?: string } | undefined;
				if (details?.status === "started") {
					return new Text(`${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(details.name ?? "subagent"))} ${theme.fg("dim", "— resumed")}`, 0, 0);
				}
				return new Text(typeof result.content[0]?.text === "string" ? result.content[0].text : "Resume failed.", 0, 0);
			},
		});

		pi.registerTool({
			name: "subagent_interrupt",
			label: "Interrupt Subagent",
			description:
				"Send Escape to a running visible Pi subagent's current turn. The pane stays open so the user can continue interacting with it.",
			promptSnippet: "Interrupt the current turn of a running visible subagent without closing its pane",
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Exact running visible subagent id" })),
				name: Type.Optional(Type.String({ description: "Exact run name or agent name; use id if ambiguous" })),
			}),
			async execute(_toolCallId, params) {
				const lookup = resolveVisibleRun(visibleSubagents.values(), params);
				if (lookup.error) {
					return {
						content: [{ type: "text", text: lookup.error }],
						details: { error: lookup.error },
						isError: true,
					};
				}
				try {
					sendVisibleEscape(lookup.run.target);
					lookup.run.status = "interrupt_requested";
					updateVisibleWidget();
					return {
						content: [{ type: "text", text: `Interrupt requested for visible subagent "${lookup.run.name}".` }],
						details: { id: lookup.run.id, name: lookup.run.name, status: "interrupt_requested" },
					};
				} catch (error) {
					const message = `Failed to send Escape to "${lookup.run.name}": ${error instanceof Error ? error.message : String(error)}`;
					return {
						content: [{ type: "text", text: message }],
						details: { error: message },
						isError: true,
					};
				}
			},
			renderCall(args, theme) {
				const target = args.id ?? args.name ?? "(unknown)";
				return new Text(
					`${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(String(target)))} ${theme.fg("dim", "— interrupt turn")}`,
					0,
					0,
				);
			},
			renderResult(result, _options, theme) {
				const details = result.details as { name?: string; status?: string } | undefined;
				if (details?.status === "interrupt_requested") {
					return new Text(
						`${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(details.name ?? "subagent"))} ${theme.fg("dim", "— interrupt requested")}`,
						0,
						0,
					);
				}
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "Interrupt failed.", 0, 0);
			},
		});

		if (typeof (pi as any).registerMessageRenderer === "function") {
			(pi as any).registerMessageRenderer("subagent_visible_result", (message: any, options: any, theme: any) => {
				const details = message.details as { name?: string; agent?: string; elapsed?: string; exitCode?: number; backend?: string; paneId?: string; ping?: string | null; sessionPath?: string } | undefined;
				const failed = (details?.exitCode ?? 0) !== 0;
				const box = new Box(1, 1, (text: string) => theme.bg(failed ? "toolErrorBg" : "toolSuccessBg", text));
				const status = details?.ping
					? "requested help"
					: failed
						? `failed (exit ${details?.exitCode ?? 1})`
						: "completed";
				const header =
					`${failed ? theme.fg("error", "✗") : theme.fg("success", "✓")} ` +
					`${theme.fg("toolTitle", theme.bold(details?.name ?? "visible-subagent"))}` +
					`${details?.agent ? theme.fg("dim", ` (${details.agent})`) : ""}` +
					`${theme.fg("dim", ` — ${status} (${details?.elapsed ?? "?"})`)}`;
				const rawText = typeof message.content === "string" ? message.content : "";
				const text = rawText.replace(/^Visible subagent "[^"\n]+" (?:completed|failed \(exit \d+\)) \([^\n]+\)\.\n?\n?/, "");
				const allLines = text ? text.split("\n") : [];
				const preview = options.expanded ? allLines : allLines.slice(0, 5);
				const lines = [header, ...preview];
				if (!options.expanded && allLines.length > preview.length) {
					lines.push(theme.fg("muted", `… ${allLines.length - preview.length} more lines`));
				}
				if (options.expanded && details?.sessionPath) {
					lines.push("");
					lines.push(theme.fg("dim", `Session: ${details.sessionPath}`));
					lines.push(theme.fg("dim", "Use subagent_resume with this sessionPath to reply."));
				}
				if (!options.expanded) lines.push(theme.fg("muted", "Ctrl+O to expand"));
				box.addChild(new Text(lines.join("\n"), 0, 0));
				return box;
			});
		}

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		refreshAgents(ctx.cwd);
		const names = agents.map((a) => a.name).join(", ") || "(none)";
		ctx.ui.notify(`🤖 Subagents loaded — ${names}`, "info");
	});
}
