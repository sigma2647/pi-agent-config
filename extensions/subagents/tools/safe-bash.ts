/**
 * safe_bash — bash execution with a dangerous-command denylist, for the worker
 * subagent. Self-contained (spawns bash directly) so it has no dependency on a
 * fork-specific `createBashTool` export.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DANGEROUS_PATTERNS: RegExp[] = [
	/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	/\bsudo\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
	/>\s*\/dev\/[sh]d[a-z]/,
	/\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
	/\bchown\s+(-[a-zA-Z]+\s+)?root/,
	/\bcurl\s.*\|\s*(ba)?sh/,
	/\bwget\s.*\|\s*(ba)?sh/,
	/\bshutdown\b/,
	/\breboot\b/,
	/\binit\s+0\b/,
	/\bkill\s+-9\s+1\b/,
	/\bkillall\b/,
];

function isDangerous(command: string): string | null {
	const normalized = command.replace(/\\\n/g, " ");
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(normalized)) {
			return `Command blocked by safe_bash: matches dangerous pattern ${pattern}`;
		}
	}
	return null;
}

function runBash(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const proc = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 2000);
		}, timeoutMs);

		const onAbort = () => {
			proc.kill("SIGTERM");
			setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 2000);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		proc.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ stdout, stderr, code: code ?? 1 });
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ stdout, stderr: stderr + String(err), code: 1 });
		});
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "safe_bash",
		label: "Safe Bash",
		description: "Execute a bash command. Blocks dangerous commands (rm -rf /, sudo, mkfs, dd, fork bombs, etc.).",
		promptSnippet: "Run a bash command with a dangerous-command denylist",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 120)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const danger = isDangerous(params.command);
			if (danger) throw new Error(danger);

			const timeoutMs = (params.timeout ?? 120) * 1000;
			const { stdout, stderr, code } = await runBash(params.command, (ctx as any).cwd ?? process.cwd(), timeoutMs, signal);

			const body = [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join("\n").trim() || "(no output)";
			return {
				content: [{ type: "text", text: body }],
				details: { exitCode: code },
				...(code !== 0 ? { isError: true } : {}),
			};
		},
	});
}
