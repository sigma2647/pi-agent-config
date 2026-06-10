// Shared CLI helpers for pi extensions. Keep in sync.
//
// Shared by tools/doctor.ts and tools/smoke.ts. Color glyphs and small
// process utilities. Always emits color — TTY-conditional coloring is the
// caller's job (smoke.ts handles its own).

import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const execFileP = promisify(execFile);

export const OK = "\x1b[32m✓\x1b[0m";
export const BAD = "\x1b[31m✗\x1b[0m";
export const WARN = "\x1b[33m!\x1b[0m";

/**
 * Basic .env parser that handles "KEY=VALUE" and "export KEY=VALUE".
 * Does not support multi-line values or complex escaping.
 */
export function tryLoadEnv(): void {
	const home = process.env.HOME || "";
	const candidates = [
		join(process.cwd(), ".env"),
		join(home, ".env"),
	];

	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const content = readFileSync(path, "utf8");
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;

				// Match [export ]KEY=VALUE
				const match = trimmed.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
				if (match) {
					const key = match[1];
					let val = match[2].trim();
					// Strip quotes if present
					if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
						val = val.slice(1, -1);
					}
					// Only set if not already present in real env
					if (!process.env[key]) {
						process.env[key] = val;
					}
				}
			}
		} catch { /* skip unreadable */ }
	}
}

export async function which(cmd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileP("which", [cmd]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

export function probeTcp(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connect({ host, port });
		const t = setTimeout(() => {
			sock.destroy();
			resolve(false);
		}, timeoutMs);
		sock.once("connect", () => {
			clearTimeout(t);
			sock.end();
			resolve(true);
		});
		sock.once("error", () => {
			clearTimeout(t);
			resolve(false);
		});
	});
}
