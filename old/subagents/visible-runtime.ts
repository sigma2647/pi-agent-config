import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import {
	buildTmuxRemainOnExitArgs,
	buildTmuxVisibleSplitArgs,
	buildVisibleShellScript,
	chooseVisibleTarget,
	isFocusedHerdrPane,
	parseVisibleBackendPreference,
	parseHerdrPaneCurrent,
	parseHerdrPaneSplit,
	shellEscape,
	type DetectedVisibleTarget,
} from "./visible-helpers.ts";

export interface VisibleRunFiles {
	scriptPath: string;
	exitFile: string;
	pingFile: string;
	sessionFile: string;
}

export interface VisibleRunTarget extends DetectedVisibleTarget {
	paneId: string;
	launchedAtCreation?: boolean;
}

function hasCommand(command: string): boolean {
	const result = spawnSync("sh", ["-lc", `command -v ${shellEscape(command)}`], { encoding: "utf8" });
	return result.status === 0;
}

function run(args: string[]): string {
	return execFileSync(args[0], args.slice(1), { encoding: "utf8" }).trim();
}

export function detectVisibleTarget(_cwd: string): DetectedVisibleTarget | null {
	const configuredBackend = parseVisibleBackendPreference(process.env.PI_SUBAGENT_VISIBLE_BACKEND);
	const tmuxPaneId = process.env.TMUX_PANE?.trim()
		|| (process.env.TMUX && hasCommand("tmux")
			? (() => {
				try {
					return run(["tmux", "display-message", "-p", "#{pane_id}"]) || null;
				} catch {
					return null;
				}
			})()
			: null);
	let herdrPaneId: string | null = null;
	if (hasCommand("herdr")) {
		try {
			const pane = parseHerdrPaneCurrent(run(["herdr", "pane", "current"]));
			if (pane?.pane_id && isFocusedHerdrPane(pane)) herdrPaneId = pane.pane_id;
		} catch {}
	}

	const preferredBackend = configuredBackend ?? (tmuxPaneId ? "tmux" : null);
	return chooseVisibleTarget({ preferredBackend, herdrPaneId, tmuxPaneId });
}

export function createVisiblePane(
	target: DetectedVisibleTarget,
	cwd: string,
	name: string,
	initialCommand?: string,
): VisibleRunTarget {
	if (target.backend === "herdr") {
		const output = run(["herdr", "pane", "split", "--pane", target.paneId, "--direction", "right", "--cwd", cwd, "--no-focus"]);
		const paneId = parseHerdrPaneSplit(output);
		if (!paneId) throw new Error(`Failed to parse Herdr pane id from: ${output || "(empty)"}`);
		try {
			run(["herdr", "pane", "rename", paneId, name]);
		} catch {}
		return { backend: "herdr", paneId };
	}

	const args = buildTmuxVisibleSplitArgs({
		anchorPaneId: target.paneId,
		cwd,
		initialCommand,
	});
	const paneId = run(args);
	if (!paneId) throw new Error("Failed to create tmux pane");
	try {
		run(buildTmuxRemainOnExitArgs(paneId));
	} catch {}
	try {
		run(["tmux", "select-pane", "-t", paneId, "-T", name]);
	} catch {}
	return { backend: "tmux", paneId, launchedAtCreation: !!initialCommand };
}

export function writeVisibleRunScript(
	files: VisibleRunFiles,
	cwd: string,
	commandArgs: string[],
	env?: Record<string, string | undefined>,
): void {
	writeFileSync(files.scriptPath, buildVisibleShellScript({
		cwd,
		commandArgs,
		exitFile: files.exitFile,
		env,
	}));
	chmodSync(files.scriptPath, 0o700);
}

export function launchVisibleRun(target: VisibleRunTarget, files: VisibleRunFiles): void {
	if (target.launchedAtCreation) return;
	const command = `bash ${shellEscape(files.scriptPath)}`;
	if (target.backend === "herdr") {
		run(["herdr", "pane", "run", target.paneId, command]);
		return;
	}
	execFileSync("tmux", ["send-keys", "-t", target.paneId, command, "Enter"], { encoding: "utf8" });
}

export function closeVisiblePane(target: VisibleRunTarget): void {
	if (target.backend === "herdr") {
		execFileSync("herdr", ["pane", "close", target.paneId], { encoding: "utf8" });
		return;
	}
	execFileSync("tmux", ["kill-pane", "-t", target.paneId], { encoding: "utf8" });
}

export function cleanupFailedVisibleLaunch(
	tempDir: string,
	target: VisibleRunTarget | null,
	closePane: (target: VisibleRunTarget) => void = closeVisiblePane,
): void {
	if (target) {
		try { closePane(target); } catch {}
	}
	try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

export function sendVisibleEscape(target: VisibleRunTarget): void {
	if (target.backend === "herdr") {
		execFileSync("herdr", ["pane", "send-keys", target.paneId, "Escape"], { encoding: "utf8" });
		return;
	}
	execFileSync("tmux", ["send-keys", "-t", target.paneId, "Escape"], { encoding: "utf8" });
}

export function tryReadVisibleExitCode(exitFile: string): number | null {
	if (!existsSync(exitFile)) return null;
	const raw = readFileSync(exitFile, "utf8").trim();
	if (raw === "done") return 0;
	const code = Number(raw);
	return Number.isInteger(code) ? code : null;
}

export function makeVisibleRunFiles(tempDir: string): VisibleRunFiles {
	return {
		scriptPath: join(tempDir, "visible-subagent.sh"),
		exitFile: join(tempDir, "visible-subagent.exit"),
		pingFile: join(tempDir, "visible-subagent.ping.json"),
		sessionFile: join(tempDir, "visible-subagent.jsonl"),
	};
}

/** Read a child help request without treating malformed local data as fatal. */
export function readVisiblePing(pingFile: string): string | null {
	if (!existsSync(pingFile)) return null;
	try {
		const parsed = JSON.parse(readFileSync(pingFile, "utf8")) as { message?: unknown };
		return typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : null;
	} catch {
		return null;
	}
}

/** Return the last assistant text from a Pi session, excluding terminal chrome. */
export function readVisibleSessionSummary(sessionFile: string): string | null {
	if (!existsSync(sessionFile)) return null;
	try {
		const lines = readFileSync(sessionFile, "utf8").split("\n").filter((line) => line.trim());
		for (let i = lines.length - 1; i >= 0; i--) {
			const entry = JSON.parse(lines[i]) as {
				type?: unknown;
				message?: { role?: unknown; content?: Array<{ type?: unknown; text?: unknown }>; stopReason?: unknown; errorMessage?: unknown };
			};
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			const text = (entry.message.content ?? [])
				.filter((block) => block.type === "text" && typeof block.text === "string" && block.text.trim())
				.map((block) => block.text as string)
				.join("\n");
			if (text.trim()) return text;
			if (entry.message.stopReason === "error" && typeof entry.message.errorMessage === "string") {
				return `Subagent error: ${entry.message.errorMessage}`;
			}
		}
	} catch {}
	return null;
}

export function readVisiblePane(target: VisibleRunTarget, lines: number = 200): string {
	if (target.backend === "herdr") {
		return execFileSync(
			"herdr",
			["pane", "read", target.paneId, "--source", "recent-unwrapped", "--lines", String(lines), "--format", "text"],
			{ encoding: "utf8" },
		);
	}
	return execFileSync(
		"tmux",
		["capture-pane", "-p", "-t", target.paneId, "-S", `-${Math.max(1, lines)}`],
		{ encoding: "utf8" },
	);
}
