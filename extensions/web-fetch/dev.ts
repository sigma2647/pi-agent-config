#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
import { fetchAndExtract } from "./core.ts";

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
  pi-wf --debug <url>            trace the fallback chain on stderr (timings
                                 and which extractor returned the result)
  pi-wf --doctor                 print environment & dependency self-check
env:
  PI_WF_PREFER_DEFUDDLE=0        opt out of defuddle-primary (use Readability)
  PI_WF_PLAYWRIGHT=1             always enable Playwright fallback
  PI_WF_DEBUG=1                  same as --debug
  PI_WF_PROFILE=<dir>            override profile dir (default ~/.pw-capture-profile)
`;

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
	process.stderr.write(USAGE);
	process.exit(args.length === 0 ? 1 : 0);
}

if (args[0] === "--doctor") {
	const { runDoctor } = await import("./tools/doctor.ts");
	await runDoctor();
	process.exit(0);
}

let mode: "fetch" | "playwright" | "login" = "fetch";
// Tri-state: undefined → use fetchAndExtract's default (env / true);
// true → explicit opt-in; false → explicit opt-out (--no-defuddle).
let preferDefuddle: boolean | undefined;
let debug = false;
let url: string | undefined;
for (const a of args) {
	if (a === "--playwright") mode = "playwright";
	else if (a === "--login") mode = "login";
	else if (a === "--defuddle") preferDefuddle = true; // no-op (default) but kept for clarity / muscle memory
	else if (a === "--no-defuddle") preferDefuddle = false;
	else if (a === "--debug") debug = true;
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

const result = await fetchAndExtract(url, undefined, { debug, preferDefuddle });

if (result.error) {
	console.error(`ERROR: ${result.error}`);
	process.exit(1);
}

const header = result.title
	? `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n`
	: "";
process.stdout.write(header + result.content + "\n");
