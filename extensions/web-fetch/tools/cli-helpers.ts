// Mirror of extensions/web-search/tools/cli-helpers.ts — keep in sync.
//
// Shared by tools/doctor.ts and tools/smoke.ts. Color glyphs and small
// process utilities. Always emits color — TTY-conditional coloring is the
// caller's job (smoke.ts handles its own).

import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { connect } from "node:net";

const execFileP = promisify(execFile);

export const OK = "\x1b[32m✓\x1b[0m";
export const BAD = "\x1b[31m✗\x1b[0m";
export const WARN = "\x1b[33m!\x1b[0m";

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
