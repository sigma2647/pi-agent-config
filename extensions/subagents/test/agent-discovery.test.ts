import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	discoverAgents,
	resolveDeniedTools,
	resolveAgentCwd,
	resolveVisibleInteractive,
} from "../agent-discovery.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeAgent(dir: string, file: string, frontmatter: string, body: string = "Prompt"): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("agent discovery", () => {
	it("applies project over global over bundled precedence", () => {
		const root = makeTempDir();
		const bundled = join(root, "bundled");
		const globalConfig = join(root, "global");
		const project = join(root, "project");
		writeAgent(bundled, "scout.md", "name: scout\ndescription: bundled\nmodel: bundled/model");
		writeAgent(join(globalConfig, "agents"), "scout.md", "name: scout\ndescription: global\nmodel: global/model");
		writeAgent(
			join(project, ".pi", "agents"),
			"scout.md",
			"name: scout\ndescription: project\nmodel: project/model\ncwd: packages/api\ndeny-tools: bash, edit\nspawning: false\nauto-exit: false\ninteractive: true",
		);

		const [scout] = discoverAgents({
			bundledDir: bundled,
			globalConfigDir: globalConfig,
			projectCwd: project,
		});
		assert.equal(scout.source, "project");
		assert.equal(scout.description, "project");
		assert.equal(scout.cwd, "packages/api");
		assert.deepEqual(scout.denyTools, ["bash", "edit"]);
		assert.equal(scout.spawning, false);
		assert.deepEqual(resolveDeniedTools(scout), ["bash", "edit", "subagent", "subagent_interrupt", "subagent_resume", "subagent_visible", "subagents_list"]);
		assert.equal(scout.autoExit, false);
		assert.equal(scout.interactive, true);
	});

	it("resolves cwd and visible interaction defaults", () => {
		const root = makeTempDir();
		const bundled = join(root, "bundled");
		writeAgent(bundled, "worker.md", "name: worker\nauto-exit: true");
		writeAgent(bundled, "planner.md", "name: planner");
		const found = discoverAgents({ bundledDir: bundled, globalConfigDir: join(root, "global"), projectCwd: root });
		const planner = found.find((agent) => agent.name === "planner")!;
		const worker = found.find((agent) => agent.name === "worker")!;

		assert.equal(resolveVisibleInteractive(undefined, worker), false);
		assert.equal(resolveVisibleInteractive(undefined, planner), true);
		assert.equal(resolveVisibleInteractive(true, worker), true);
		assert.equal(resolveAgentCwd(root, undefined, "packages/api"), join(root, "packages/api"));
		assert.equal(resolveAgentCwd(root, "/tmp/override", "ignored"), "/tmp/override");
	});
});
