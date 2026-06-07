# pi-wf / pi-ws --smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `pi-wf --smoke` and `pi-ws --smoke` quick end-to-end health-check commands, ≤ 15 s each, ≤ 30 s combined.

**Architecture:** Per-extension `tools/smoke.ts` that `execFile()`s the installed CLI as subprocess and asserts exit code + size + pattern (pi-wf) or exit + JSON + `results.length` (pi-ws). Shared `tools/cli-helpers.ts` refactored out of the existing `tools/doctor.ts` (one byte-mirror copy per extension — never cross-imported; rationale in spec §3).

**Tech Stack:** TypeScript via Node `--experimental-strip-types` (Node ≥ 22.6). No unit-test framework — the codebase's testing pattern is "run the CLI and check stdout" (see `extensions/web-fetch/tests/stress.sh`). Dispatch mirrors the existing `--doctor` pattern in both `dev.ts` files.

**Spec:** `docs/superpowers/specs/2026-06-07-pi-wf-ws-smoke-design.md`

---

## File Structure

**New files:**
- `extensions/web-fetch/tools/cli-helpers.ts` — `OK` / `BAD` / `WARN` glyphs + `which()` + `probeTcp()` (extracted from doctor.ts)
- `extensions/web-fetch/tools/smoke.ts` — `runSmoke()` orchestrates 3 cases against `pi-wf`
- `extensions/web-search/tools/cli-helpers.ts` — byte-mirror of web-fetch's (per-extension copy by design)
- `extensions/web-search/tools/smoke.ts` — `runSmoke()` for 2 cases against `pi-ws`

**Modified files:**
- `extensions/web-fetch/tools/doctor.ts` — remove inline helpers, import from `./cli-helpers.ts`
- `extensions/web-search/tools/doctor.ts` — same
- `extensions/web-fetch/dev.ts` — add `--smoke` flag dispatch + USAGE entry
- `extensions/web-search/dev.ts` — same

---

### Task 1: Extract cli-helpers from web-fetch/tools/doctor.ts (refactor, no behavior change)

**Files:**
- Create: `extensions/web-fetch/tools/cli-helpers.ts`
- Modify: `extensions/web-fetch/tools/doctor.ts:9-67`

- [ ] **Step 1: Capture current `pi-wf --doctor` output as baseline**

```bash
pi-wf --doctor > /tmp/doctor-wf-before.txt 2>&1
wc -l /tmp/doctor-wf-before.txt
```

Expected: a non-empty file (10-30 lines depending on env).

- [ ] **Step 2: Create `extensions/web-fetch/tools/cli-helpers.ts`**

```ts
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
```

- [ ] **Step 3: Refactor `extensions/web-fetch/tools/doctor.ts` to import from cli-helpers**

Replace lines 9-67 (imports + ANSI constants + `which` + `probeTcp`; **keep** `probeDefuddleLib` and `parseProxy` — they're doctor-specific) with:

```ts
import { access, readdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { loadPlaywright } from "../playwright.ts";
import { OK, BAD, WARN, which, probeTcp } from "./cli-helpers.ts";

async function probeDefuddleLib(): Promise<boolean> {
	try {
		const m: any = await import("defuddle/node");
		return typeof (m.Defuddle ?? m.default?.Defuddle) === "function";
	} catch {
		return false;
	}
}

function parseProxy(url: string | undefined): { host: string; port: number } | null {
	if (!url) return null;
	try {
		const u = new URL(url);
		return { host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) };
	} catch {
		return null;
	}
}
```

(`runDoctor()` and the bottom CLI-entry block are unchanged.)

Dead imports removed from doctor.ts (they all moved to cli-helpers or were only used by helpers that moved): `promisify`, `execFile`, `execFileP`, `connect`.

- [ ] **Step 4: Verify byte-identical output**

```bash
pi-wf --doctor > /tmp/doctor-wf-after.txt 2>&1
diff /tmp/doctor-wf-before.txt /tmp/doctor-wf-after.txt
echo "exit=$?"
```

Expected: `exit=0` (no diff). If there's a diff, the refactor changed behavior — investigate before continuing.

- [ ] **Step 5: Commit**

```bash
git -C /home/lawrence/pi-agent-config add extensions/web-fetch/tools/cli-helpers.ts extensions/web-fetch/tools/doctor.ts
git -C /home/lawrence/pi-agent-config commit -m "$(cat <<'EOF'
refactor(web-fetch): extract cli-helpers from tools/doctor.ts

Move ANSI glyphs (OK/BAD/WARN), which(), probeTcp() into tools/cli-helpers.ts
so the upcoming tools/smoke.ts can share them. Behavior of pi-wf --doctor
unchanged (byte-identical output verified via diff).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add pi-wf --smoke (3 cases) + dev.ts wiring

**Files:**
- Create: `extensions/web-fetch/tools/smoke.ts`
- Modify: `extensions/web-fetch/dev.ts:4-26` (USAGE) and after line 38 (dispatch)

- [ ] **Step 1: Write the failing test (run smoke before it exists)**

```bash
pi-wf --smoke
echo "exit=$?"
```

Expected: USAGE printed to stderr, `exit=1` (treated as unknown URL `--smoke` and then bails). This is the "test fails because feature doesn't exist yet" state.

- [ ] **Step 2: Create `extensions/web-fetch/tools/smoke.ts`**

```ts
#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
// pi-wf --smoke — quick end-to-end self-check.
//
// Runs 3 cases against the installed pi-wf CLI as subprocess, asserting
// exit code + output size + key pattern. ~5s total on happy path. Sits
// between --doctor (env triage) and tests/stress.sh (regression).

import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { which } from "./cli-helpers.ts";

const execFileP = promisify(execFile);

interface SmokeCase {
	id: string;
	args: string[];
	minBytes: number;
	pattern: RegExp;
	skipIf?: () => Promise<boolean>;
}

interface CaseResult {
	id: string;
	status: "PASS" | "FAIL" | "SKIP";
	bytes: number;
	elapsedMs: number;
	reason?: string;
	stderrHead?: string;
}

const CASES: SmokeCase[] = [
	{
		id: "wiki-defuddle",
		args: ["https://en.wikipedia.org/wiki/HTTP"],
		minBytes: 2048,
		pattern: /Hypertext Transfer/,
	},
	{
		id: "github-readme",
		args: ["https://github.com/anthropics/claude-code"],
		minBytes: 500,
		pattern: /anthropics\/claude-code/,
	},
	{
		id: "hn-item",
		args: ["https://news.ycombinator.com/item?id=39000000"],
		minBytes: 200,
		pattern: /HN item/,
	},
];

const PER_CASE_TIMEOUT_MS = 15000;
const TOTAL_TIMEOUT_MS = 30000;

const useColor = process.stdout.isTTY === true;
const G = useColor ? "\x1b[32m" : "";
const R = useColor ? "\x1b[31m" : "";
const Y = useColor ? "\x1b[33m" : "";
const NC = useColor ? "\x1b[0m" : "";

async function runCase(c: SmokeCase, deadline: number): Promise<CaseResult> {
	if (c.skipIf && (await c.skipIf())) {
		return { id: c.id, status: "SKIP", bytes: 0, elapsedMs: 0, reason: "dep missing" };
	}
	const t0 = Date.now();
	const remaining = deadline - t0;
	if (remaining <= 0) {
		return { id: c.id, status: "FAIL", bytes: 0, elapsedMs: 0, reason: "total timeout exhausted" };
	}
	const timeout = Math.min(PER_CASE_TIMEOUT_MS, remaining);
	try {
		const { stdout, stderr } = await execFileP("pi-wf", c.args, {
			timeout,
			maxBuffer: 20 * 1024 * 1024,
		});
		const elapsedMs = Date.now() - t0;
		const bytes = Buffer.byteLength(stdout, "utf8");
		const stderrHead = stderr.split("\n").slice(0, 2).join("\n");
		if (bytes < c.minBytes) {
			return { id: c.id, status: "FAIL", bytes, elapsedMs,
				reason: `size=${bytes}B < min=${c.minBytes}B`, stderrHead };
		}
		if (!c.pattern.test(stdout)) {
			return { id: c.id, status: "FAIL", bytes, elapsedMs,
				reason: `pattern not found: ${c.pattern.source}`, stderrHead };
		}
		return { id: c.id, status: "PASS", bytes, elapsedMs };
	} catch (err: any) {
		const elapsedMs = Date.now() - t0;
		const isTimeout = err.killed === true && (err.signal === "SIGTERM" || err.code === null);
		const reason = isTimeout ? `timeout after ${timeout}ms` : `exit=${err.code ?? "?"}`;
		const stderrHead = (err.stderr ?? "").toString().split("\n").slice(0, 2).join("\n");
		return { id: c.id, status: "FAIL", bytes: 0, elapsedMs, reason, stderrHead };
	}
}

export async function runSmoke(): Promise<number> {
	const piwf = await which("pi-wf");
	if (!piwf) {
		process.stderr.write("error: pi-wf not found on PATH — run extensions/install.sh\n");
		return 1;
	}

	console.log("pi-wf smoke:\n");
	const wallStart = Date.now();
	const deadline = wallStart + TOTAL_TIMEOUT_MS;
	const results: CaseResult[] = [];
	for (const c of CASES) {
		const r = await runCase(c, deadline);
		results.push(r);
		const tag =
			r.status === "PASS" ? `${G}PASS${NC}` :
			r.status === "FAIL" ? `${R}FAIL${NC}` :
			                      `${Y}SKIP${NC}`;
		const size = r.bytes ? `${r.bytes}B` : "—";
		const t = r.elapsedMs ? `${(r.elapsedMs / 1000).toFixed(1)}s` : "—";
		const tail = r.reason ? `  ${Y}${r.reason}${NC}` : "";
		console.log(`  ${tag}  ${r.id.padEnd(20)} ${size.padStart(6)}  ${t.padStart(5)}${tail}`);
		if (r.stderrHead) {
			for (const line of r.stderrHead.split("\n")) {
				if (line) console.log(`        | ${line}`);
			}
		}
	}

	const wallMs = Date.now() - wallStart;
	const pass = results.filter((r) => r.status === "PASS").length;
	const fail = results.filter((r) => r.status === "FAIL").length;
	const skip = results.filter((r) => r.status === "SKIP").length;
	console.log(`\n  pass=${G}${pass}${NC}  fail=${R}${fail}${NC}  skip=${Y}${skip}${NC}  wall=${(wallMs / 1000).toFixed(1)}s`);
	if (fail > 0) {
		console.log("\n  Hint: run pi-wf --doctor to triage env");
		return 1;
	}
	return 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	process.exit(await runSmoke());
}
```

- [ ] **Step 3: Wire `--smoke` dispatch in `extensions/web-fetch/dev.ts`**

After line 38 (the existing `--doctor` block ends with `process.exit(0);`), insert:

```ts
if (args[0] === "--smoke") {
	const { runSmoke } = await import("./tools/smoke.ts");
	process.exit(await runSmoke());
}
```

And in the USAGE template (around line 20, after the `--doctor` line), add:

```
  pi-wf --smoke                  quick end-to-end self-check (3 cases, ~5s)
```

So the USAGE block looks like:

```ts
const USAGE = `usage:
  pi-wf <url>                    fetch + extract (text out on stdout)
                                 Defuddle is the default extractor — cleaner
                                 Pandoc footnotes, schema.org metadata, more
                                 complete section structure (good for LLMs).
  pi-wf --no-defuddle <url>      use the lighter Readability path instead
                                 (~260ms faster, but loses section structure
                                 and Pandoc footnote semantics)
  pi-wf --playwright <url>       force Playwright fallback for this call
  pi-wf --login <url>            open a headed Chromium with the persistent
                                 profile so you can log in once; cookies are
                                 saved to the profile dir (see --doctor) and
                                 reused by future --playwright runs.
  pi-wf --proxy <url> <url>      route through a proxy (e.g. --proxy http://127.0.0.1:7890)
  pi-wf --debug <url>            trace the fallback chain on stderr (timings
                                 and which extractor returned the result)
  pi-wf --doctor                 print environment & dependency self-check
  pi-wf --smoke                  quick end-to-end self-check (3 cases, ~5s)
env:
...
```

- [ ] **Step 4: Run `pi-wf --smoke` end-to-end; expect 3 PASS**

```bash
pi-wf --smoke
echo "exit=$?"
```

Expected output (timings/sizes vary):

```
pi-wf smoke:

  PASS  wiki-defuddle        3245B    1.2s
  PASS  github-readme        2891B    0.8s
  PASS  hn-item               847B    0.4s

  pass=3  fail=0  skip=0  wall=2.4s
exit=0
```

If any case FAILs:
1. Check network: `pi-wf https://en.wikipedia.org/wiki/HTTP | head -20` should print clean markdown
2. Check env: `pi-wf --doctor`
3. The stderr head in the smoke output will say more

- [ ] **Step 5: Verify non-TTY output has no ANSI codes**

```bash
pi-wf --smoke | cat | od -c | grep -c $'\033'
```

Expected: `0` (no ESC bytes in piped output).

- [ ] **Step 6: Commit**

```bash
git -C /home/lawrence/pi-agent-config add extensions/web-fetch/tools/smoke.ts extensions/web-fetch/dev.ts
git -C /home/lawrence/pi-agent-config commit -m "$(cat <<'EOF'
feat(web-fetch): add pi-wf --smoke quick end-to-end self-check

Runs 3 cases (wikipedia → Defuddle path, github → domain extractor,
HN item → another domain extractor) against the installed pi-wf as
subprocess. ~5s total on happy path. Sits between --doctor (env
triage) and tests/stress.sh (full regression).

Exit 0 if all PASS or PASS+SKIP, 1 if any FAIL. Non-TTY output strips
ANSI codes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Mirror cli-helpers to web-search + refactor its doctor.ts

**Files:**
- Create: `extensions/web-search/tools/cli-helpers.ts`
- Modify: `extensions/web-search/tools/doctor.ts:10-47`

- [ ] **Step 1: Capture current `pi-ws --doctor` output as baseline**

```bash
pi-ws --doctor > /tmp/doctor-ws-before.txt 2>&1
wc -l /tmp/doctor-ws-before.txt
```

Expected: non-empty file (~25-40 lines).

- [ ] **Step 2: Create `extensions/web-search/tools/cli-helpers.ts` (byte-mirror of web-fetch's, only the header comment differs)**

```ts
// Mirror of extensions/web-fetch/tools/cli-helpers.ts — keep in sync.
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
```

Verify byte-identity to the web-fetch copy (only the first comment line differs):

```bash
diff <(sed '1d' extensions/web-fetch/tools/cli-helpers.ts) <(sed '1d' extensions/web-search/tools/cli-helpers.ts)
echo "diff exit=$?"
```

Expected: `diff exit=0`.

- [ ] **Step 3: Refactor `extensions/web-search/tools/doctor.ts` to import from cli-helpers**

Replace lines 10-47 (imports + `OK`/`BAD`/`WARN`/`which`/`probeTcp` definitions; the `parseHostPort` and `mask` helpers below them stay) with:

```ts
import { loadConfig, listBackends, registerDefaultBackends } from "../chain.ts";
import { OK, BAD, WARN, which, probeTcp } from "./cli-helpers.ts";
```

The whole new top of `doctor.ts` should be:

```ts
#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
// pi-ws --doctor — environment & backend self-check.
//
// Mirrors `pi-wf --doctor` but for the web-search chain. Prints a one-glance
// report of: Node version, the effective chain + timeouts, each registered
// backend's availability (via its own isAvailable()) plus an actionable hint,
// and the relevant env vars. Designed to answer "why does backend X get
// skipped?" without digging through AGENTS.md.

import { loadConfig, listBackends, registerDefaultBackends } from "../chain.ts";
import { OK, BAD, WARN, which, probeTcp } from "./cli-helpers.ts";

function parseHostPort(url: string | undefined): { host: string; port: number } | null {
	if (!url) return null;
	try {
		const u = new URL(url);
		return { host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) };
	} catch {
		return null;
	}
}

function mask(secret: string): string {
	if (secret.length <= 8) return "****";
	return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
}
```

(`runDoctor()` and the CLI-entry block at the bottom are unchanged.)

Notes:
- The inline `which()` in the old doctor used `spawn("sh", ["-c", "command -v X"])` — replacing with the cli-helpers `execFile("which", X)` is functionally identical for "is this binary on PATH": both return path or null. No output difference.
- The old `spawn` and `connect` imports are now gone from doctor.ts (only used by the inline helpers we extracted).

- [ ] **Step 4: Verify byte-identical doctor output**

```bash
pi-ws --doctor > /tmp/doctor-ws-after.txt 2>&1
diff /tmp/doctor-ws-before.txt /tmp/doctor-ws-after.txt
echo "exit=$?"
```

Expected: `exit=0`.

If there's a diff, the most likely cause is a stray formatting tweak — investigate before continuing.

- [ ] **Step 5: Commit**

```bash
git -C /home/lawrence/pi-agent-config add extensions/web-search/tools/cli-helpers.ts extensions/web-search/tools/doctor.ts
git -C /home/lawrence/pi-agent-config commit -m "$(cat <<'EOF'
refactor(web-search): mirror cli-helpers + refactor tools/doctor.ts

Add tools/cli-helpers.ts as byte-mirror of web-fetch's (per-extension
copy by design — see spec §3). Refactor tools/doctor.ts to import OK/BAD/
WARN, which, probeTcp from it. pi-ws --doctor output byte-identical
(verified via diff).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add pi-ws --smoke (2 cases) + dev.ts wiring

**Files:**
- Create: `extensions/web-search/tools/smoke.ts`
- Modify: `extensions/web-search/dev.ts:6-27` (USAGE) and after line 39 (dispatch)

- [ ] **Step 1: Confirm `pi-ws --smoke` doesn't exist yet (fail test)**

```bash
pi-ws --smoke
echo "exit=$?"
```

Expected: error "unknown flag: --smoke" (matched by `else if (a.startsWith("--"))` branch at line 116) and `exit=2`.

- [ ] **Step 2: Create `extensions/web-search/tools/smoke.ts`**

```ts
#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
// pi-ws --smoke — quick end-to-end self-check.
//
// Runs 2 cases against the installed pi-ws CLI, asserting exit code +
// valid JSON + results.length >= minResults. ~3-8s on happy path.
// case 2 (force-opencli) SKIPs if opencli is not on PATH.

import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { which } from "./cli-helpers.ts";

const execFileP = promisify(execFile);

interface SmokeCase {
	id: string;
	args: string[];
	minResults: number;
	skipIf?: () => Promise<boolean>;
}

interface CaseResult {
	id: string;
	status: "PASS" | "FAIL" | "SKIP";
	resultCount: number;
	elapsedMs: number;
	reason?: string;
	stderrHead?: string;
}

const CASES: SmokeCase[] = [
	{
		id: "default-chain",
		args: ["wikipedia HTTP RFC"],
		minResults: 3,
	},
	{
		id: "force-opencli",
		args: ["--chain", "opencli", "wikipedia HTTP RFC"],
		minResults: 3,
		skipIf: async () => (await which("opencli")) === null,
	},
];

const PER_CASE_TIMEOUT_MS = 15000;
const TOTAL_TIMEOUT_MS = 30000;

const useColor = process.stdout.isTTY === true;
const G = useColor ? "\x1b[32m" : "";
const R = useColor ? "\x1b[31m" : "";
const Y = useColor ? "\x1b[33m" : "";
const NC = useColor ? "\x1b[0m" : "";

async function runCase(c: SmokeCase, deadline: number): Promise<CaseResult> {
	if (c.skipIf && (await c.skipIf())) {
		return { id: c.id, status: "SKIP", resultCount: 0, elapsedMs: 0, reason: "opencli not on PATH" };
	}
	const t0 = Date.now();
	const remaining = deadline - t0;
	if (remaining <= 0) {
		return { id: c.id, status: "FAIL", resultCount: 0, elapsedMs: 0, reason: "total timeout exhausted" };
	}
	const timeout = Math.min(PER_CASE_TIMEOUT_MS, remaining);
	try {
		const { stdout, stderr } = await execFileP("pi-ws", c.args, {
			timeout,
			maxBuffer: 20 * 1024 * 1024,
		});
		const elapsedMs = Date.now() - t0;
		const stderrHead = stderr.split("\n").slice(0, 2).join("\n");
		let parsed: any;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			return { id: c.id, status: "FAIL", resultCount: 0, elapsedMs,
				reason: "stdout not valid JSON", stderrHead };
		}
		if (parsed.kind !== "ok") {
			return { id: c.id, status: "FAIL", resultCount: 0, elapsedMs,
				reason: `kind=${parsed.kind ?? "?"}`, stderrHead };
		}
		const count = Array.isArray(parsed.results) ? parsed.results.length : 0;
		if (count < c.minResults) {
			return { id: c.id, status: "FAIL", resultCount: count, elapsedMs,
				reason: `results=${count} < min=${c.minResults}`, stderrHead };
		}
		return { id: c.id, status: "PASS", resultCount: count, elapsedMs };
	} catch (err: any) {
		const elapsedMs = Date.now() - t0;
		const isTimeout = err.killed === true && (err.signal === "SIGTERM" || err.code === null);
		const reason = isTimeout ? `timeout after ${timeout}ms` : `exit=${err.code ?? "?"}`;
		const stderrHead = (err.stderr ?? "").toString().split("\n").slice(0, 2).join("\n");
		return { id: c.id, status: "FAIL", resultCount: 0, elapsedMs, reason, stderrHead };
	}
}

export async function runSmoke(): Promise<number> {
	const piws = await which("pi-ws");
	if (!piws) {
		process.stderr.write("error: pi-ws not found on PATH — run extensions/install.sh\n");
		return 1;
	}

	console.log("pi-ws smoke:\n");
	const wallStart = Date.now();
	const deadline = wallStart + TOTAL_TIMEOUT_MS;
	const results: CaseResult[] = [];
	for (const c of CASES) {
		const r = await runCase(c, deadline);
		results.push(r);
		const tag =
			r.status === "PASS" ? `${G}PASS${NC}` :
			r.status === "FAIL" ? `${R}FAIL${NC}` :
			                      `${Y}SKIP${NC}`;
		const cnt = r.resultCount ? `${r.resultCount} hits` : "—";
		const t = r.elapsedMs ? `${(r.elapsedMs / 1000).toFixed(1)}s` : "—";
		const tail = r.reason ? `  ${Y}${r.reason}${NC}` : "";
		console.log(`  ${tag}  ${r.id.padEnd(20)} ${cnt.padStart(8)}  ${t.padStart(5)}${tail}`);
		if (r.stderrHead) {
			for (const line of r.stderrHead.split("\n")) {
				if (line) console.log(`        | ${line}`);
			}
		}
	}

	const wallMs = Date.now() - wallStart;
	const pass = results.filter((r) => r.status === "PASS").length;
	const fail = results.filter((r) => r.status === "FAIL").length;
	const skip = results.filter((r) => r.status === "SKIP").length;
	console.log(`\n  pass=${G}${pass}${NC}  fail=${R}${fail}${NC}  skip=${Y}${skip}${NC}  wall=${(wallMs / 1000).toFixed(1)}s`);
	if (fail > 0) {
		console.log("\n  Hint: run pi-ws --doctor to triage env");
		return 1;
	}
	return 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	process.exit(await runSmoke());
}
```

**Note on JSON shape:** `pi-ws` outputs `runChain()` result directly (see `dev.ts:139`), which has `kind: "ok" | "fail"`. The assertion checks `parsed.kind === "ok"` not `parsed.ok === true` (the latter is the agent-tool JSON shape from `index.ts:formatResultsJson`, which the CLI doesn't use).

- [ ] **Step 3: Wire `--smoke` dispatch in `extensions/web-search/dev.ts`**

After line 39 (the existing `--doctor` block ends with `process.exit(0);`), insert:

```ts
if (args[0] === "--smoke") {
	const { runSmoke } = await import("./tools/smoke.ts");
	process.exit(await runSmoke());
}
```

And in USAGE around line 19 (after the `--doctor` line), add:

```
  pi-ws --smoke                  quick end-to-end self-check (2 cases, ~5s)
```

Resulting USAGE excerpt:

```
  pi-ws --list                   list registered backends + effective chain
  pi-ws --doctor                 environment & backend self-check
  pi-ws --smoke                  quick end-to-end self-check (2 cases, ~5s)
  pi-ws --json <query>           alias for --format json (kept for muscle memory)
```

- [ ] **Step 4: Run `pi-ws --smoke` end-to-end; expect 1-2 PASS, possibly 1 SKIP**

```bash
pi-ws --smoke
echo "exit=$?"
```

Expected (when opencli is installed):

```
pi-ws smoke:

  PASS  default-chain        10 hits   1.2s
  PASS  force-opencli         8 hits   2.4s

  pass=2  fail=0  skip=0  wall=3.6s
exit=0
```

Or (when opencli is NOT installed):

```
pi-ws smoke:

  PASS  default-chain        10 hits   1.2s
  SKIP  force-opencli              —      —  opencli not on PATH

  pass=1  fail=0  skip=1  wall=1.2s
exit=0
```

- [ ] **Step 5: Verify non-TTY output strips ANSI codes**

```bash
pi-ws --smoke | cat | od -c | grep -c $'\033'
```

Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git -C /home/lawrence/pi-agent-config add extensions/web-search/tools/smoke.ts extensions/web-search/dev.ts
git -C /home/lawrence/pi-agent-config commit -m "$(cat <<'EOF'
feat(web-search): add pi-ws --smoke quick end-to-end self-check

Runs 2 cases (default chain → first non-empty backend; force-opencli
→ exercises fallback when Brave is normal). case 2 SKIPs if opencli
is not on PATH. Asserts valid JSON + kind=ok + results.length >= 3.

Exit 0 if all PASS or PASS+SKIP, 1 if any FAIL. Non-TTY strips ANSI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Verify spec §11 acceptance criteria

**Files:** None modified. This task only runs assertions and gates merge.

- [ ] **Step 1: Criterion 1 — `pi-wf --smoke` ≤ 5 s on happy path**

```bash
time pi-wf --smoke
echo "exit=$?"
```

Expected: `pass=3 fail=0`, `wall=X.Xs` where X ≤ 5 (allow up to 10 if network slow); `exit=0`. Note: smoke runs 3 sequential cases; per spec §7 per-case timeout is 15 s, so worst-case for the whole task is 30 s — but happy-path should be well under 5 s.

- [ ] **Step 2: Criterion 2 — `pi-ws --smoke` ≤ 8 s on happy path**

```bash
time pi-ws --smoke
echo "exit=$?"
```

Expected: `pass>=1`, `fail=0`, `wall=X.Xs` X ≤ 8; `exit=0`.

- [ ] **Step 3: Criterion 3 — FAIL surfaces stderr + doctor hint**

Force a failure by pointing at a non-existent host:

```bash
# temporary: monkeypatch the first case to a bad URL via env
# alternative: hand-edit CASES, run, revert. simpler approach:
pi-wf https://nonexistent.invalid.example.test/ 2>&1 | head -3
```

Then check smoke wraps that failure correctly: edit one case URL in smoke.ts to the bad URL, run `pi-wf --smoke`, observe FAIL line with `exit=N` or `timeout` reason + indented stderr head + "Hint: run pi-wf --doctor". Revert the edit.

(This is a manual test — not automated. Skip if you trust the code path.)

- [ ] **Step 4: Criterion 4 — SKIP behavior**

If opencli is already not installed, regular `pi-ws --smoke` exercises SKIP.

If opencli IS installed, force SKIP by hiding only its dir from PATH (keep
pi-ws's `~/.local/bin` dir so the binary is still found):

```bash
opencli_dir=$(dirname "$(which opencli)")
PATH=$(echo "$PATH" | sed -e "s|${opencli_dir}:||g" -e "s|:${opencli_dir}||g") pi-ws --smoke
```

Expected: case 2 shows `SKIP  force-opencli   ...   opencli not on PATH`, summary `skip=1`, `exit=0`.

- [ ] **Step 5: Criterion 5 — doctor output byte-identical to pre-refactor**

Already verified during Tasks 1 and 3 (diff against baseline). Re-confirm just to be safe:

```bash
pi-wf --doctor | diff /tmp/doctor-wf-before.txt - && echo "wf: identical"
pi-ws --doctor | diff /tmp/doctor-ws-before.txt - && echo "ws: identical"
```

Expected: both print `identical`.

- [ ] **Step 6: Criterion 6 — cli-helpers.ts byte-identical except header**

```bash
diff <(sed '1d' extensions/web-fetch/tools/cli-helpers.ts) <(sed '1d' extensions/web-search/tools/cli-helpers.ts)
echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 7: Criterion 7 — non-TTY strips color**

```bash
pi-wf --smoke | cat | od -c | grep -c $'\033'
pi-ws --smoke | cat | od -c | grep -c $'\033'
```

Expected: both print `0`.

- [ ] **Step 8: All criteria pass → feature complete**

No commit needed for this task — verification only. If all 7 criteria green, the feature is ready for the user to push (`git push` is up to the user; this plan never pushes automatically).

If any criterion fails, file a follow-up task to fix it before considering the feature done.

---

## Notes for the implementer

- **Pi loader vs CLI:** This work is CLI-only. The pi-loader `index.ts` (which registers `web_fetch` / `web_search` agent tools) is not touched. Smoke is a developer / ops convenience, not an agent capability.
- **No new dependencies:** Everything is `node:` stdlib + the existing extension files. No `npm install` needed.
- **The two `cli-helpers.ts` files are intentionally NOT cross-imported.** See spec §3 for rationale. If you find yourself tempted to symlink them or hoist into `extensions/_common/`, re-read the spec — the per-path-resolution friction outweighs the duplication, and the constants/helpers don't change.
- **`describe` errors when smoke fails:** the smoke output includes the stderr head from the child CLI; if you want more detail, run the underlying command directly (e.g. `pi-wf https://en.wikipedia.org/wiki/HTTP`) outside smoke.
- **No `--json` for smoke this round.** Spec §10 says future work. Don't add it as scope creep.
