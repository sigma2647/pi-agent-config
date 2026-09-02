#!/usr/bin/env node
// Smoke-check: load every extension pi will load, using pi's own jiti loader.
//
// Catches the "installed fine, but pi fails at startup" class of breakage
// (missing relative imports, bad syntax, unresolvable packages) before it
// ships. Reads the same declaration pi reads: package.json "pi.extensions".
//
// Usage: node extensions/check.mjs   (or: just check)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.dirname(EXT_DIR);
const rel = (p) => path.relative(REPO_ROOT, p);

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

// ── Locate the installed pi package ──
// Extension code resolves @earendil-works/* peer deps from pi's node_modules,
// so we load through pi's jiti and alias those packages there.
let bin;
try {
	bin = execFileSync("/bin/sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
} catch {
	/* empty */
}
if (!bin) fail("pi not on PATH — cannot verify extension loading");

let piPkg = path.dirname(realpathSync(bin));
while (piPkg !== "/" && !existsSync(path.join(piPkg, "package.json"))) {
	piPkg = path.dirname(piPkg);
}
if (piPkg === "/") fail(`could not locate pi package from ${bin}`);
const pkgName = JSON.parse(readFileSync(path.join(piPkg, "package.json"), "utf8")).name;
if (pkgName !== "@earendil-works/pi-coding-agent") {
	fail(`unexpected package at ${piPkg} (${pkgName})`);
}

// ── Collect extension entry files (same declarations pi reads) ──
function extensionFiles(pkgDir) {
	const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
	const entries = pkg.pi?.extensions ?? [];
	const files = [];
	for (const entry of entries) {
		const abs = path.resolve(pkgDir, entry);
		if (existsSync(abs) && abs.endsWith(".ts")) {
			files.push(abs);
		} else if (existsSync(path.join(abs, "package.json"))) {
			files.push(...extensionFiles(abs));
		} else if (existsSync(`${abs}.ts`)) {
			files.push(`${abs}.ts`);
		} else {
			fail(`${rel(abs)} — declared in pi.extensions but not found`);
		}
	}
	return files;
}

const files = extensionFiles(REPO_ROOT);
if (files.length === 0) fail("no pi.extensions declared in root package.json");

// ── Load each entry with pi's jiti ──
const jitiPath = path.join(piPkg, "node_modules", "jiti", "lib", "jiti.mjs");
if (!existsSync(jitiPath)) fail(`jiti not found at ${rel(jitiPath)}`);
const { createJiti } = await import(pathToFileURL(jitiPath).href);

const alias = {};
const scope = path.join(piPkg, "node_modules", "@earendil-works");
for (const name of readdirSync(scope)) {
	alias[`@earendil-works/${name}`] = path.join(scope, name);
}
alias["@earendil-works/pi-coding-agent"] = piPkg;

const jiti = createJiti(path.join(REPO_ROOT, "check.ts"), { alias });

let bad = 0;
for (const file of files) {
	try {
		const mod = await jiti.import(pathToFileURL(file).href);
		const fn = mod.default ?? mod;
		if (typeof fn !== "function") {
			console.error(`✗ ${rel(file)} — default export is ${typeof fn}, expected function`);
			bad++;
			continue;
		}
		console.log(`✓ ${rel(file)}`);
	} catch (e) {
		console.error(`✗ ${rel(file)} — ${String(e.message).split("\n")[0]}`);
		bad++;
	}
}

if (bad > 0) {
	console.error(`
${bad} of ${files.length} extension(s) failed to load.
hint: if a file was deleted by mistake, recover it with:
  git log --oneline --all --diff-filter=D -- <path>   # find the deleting commit
  git checkout <commit>~1 -- <path>                   # restore the file`);
	process.exit(1);
}
console.log(`\nall ${files.length} extension(s) load cleanly`);
