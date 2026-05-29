#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
import { fetchAndExtract } from "./core.ts";

const USAGE = `usage:
  pi-wf <url>                    fetch + extract (text out on stdout)
  pi-wf --playwright <url>       force Playwright fallback for this call
  pi-wf --login <url>            open a headed Chromium with the persistent
                                 profile so you can log in once; cookies are
                                 saved to ~/.pw-capture-profile and reused by
                                 future --playwright runs.
env:
  PI_WF_PLAYWRIGHT=1             always enable Playwright fallback
  PI_WF_PROFILE=<dir>            override profile dir (default ~/.pw-capture-profile)
`;

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
	process.stderr.write(USAGE);
	process.exit(args.length === 0 ? 1 : 0);
}

let mode: "fetch" | "playwright" | "login" = "fetch";
let url: string | undefined;
for (const a of args) {
	if (a === "--playwright") mode = "playwright";
	else if (a === "--login") mode = "login";
	else if (!url) url = a;
	else {
		process.stderr.write(`unexpected arg: ${a}\n${USAGE}`);
		process.exit(1);
	}
}
if (!url) {
	process.stderr.write(USAGE);
	process.exit(1);
}

if (mode === "login") {
	const { runLoginBootstrap } = await import("./tools/login_bootstrap.ts");
	await runLoginBootstrap(url);
	process.exit(0);
}

if (mode === "playwright") {
	// Enable the fallback for this call. The flag is checked inside core.ts
	// via process.env.PI_WF_PLAYWRIGHT.
	process.env.PI_WF_PLAYWRIGHT = "1";
}

const result = await fetchAndExtract(url);

if (result.error) {
	console.error(`ERROR: ${result.error}`);
	process.exit(1);
}

const header = result.title
	? `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n`
	: "";
process.stdout.write(header + result.content + "\n");
