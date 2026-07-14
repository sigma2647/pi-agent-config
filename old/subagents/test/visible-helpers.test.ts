import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildTmuxRemainOnExitArgs,
	buildTmuxVisibleSplitArgs,
	buildVisiblePaneLaunchCommand,
	buildVisibleShellScript,
	buildVisibleSubagentUserMessage,
	chooseVisibleTarget,
	dispatchVisibleFirst,
	isFocusedHerdrPane,
	parseVisibleBackendPreference,
	parseHerdrPaneCurrent,
	parseHerdrPaneSplit,
	pathLooksRelated,
	resolveVisibleRun,
	shouldUseHerdrForCwd,
} from "../visible-helpers.ts";

describe("visible subagent helpers", () => {
	it("parses herdr pane current json", () => {
		const pane = parseHerdrPaneCurrent(JSON.stringify({
			id: "cli:pane:current",
			result: {
				type: "pane_current",
				pane: {
					pane_id: "w1Z:p2",
					cwd: "/repo/project",
					foreground_cwd: "/repo/project/subdir",
					focused: true,
				},
			},
		}));
		assert.deepEqual(pane, {
			pane_id: "w1Z:p2",
			cwd: "/repo/project",
			foreground_cwd: "/repo/project/subdir",
			focused: true,
		});
		assert.equal(isFocusedHerdrPane(pane), true);
	});

	it("parses herdr split responses with json or regex fallback", () => {
		assert.equal(parseHerdrPaneSplit('{"result":{"pane":{"pane_id":"w1Z:p9"}}}'), "w1Z:p9");
		assert.equal(parseHerdrPaneSplit("created pane w1Z:pA"), "w1Z:pA");
	});

	it("matches related cwd values for herdr backend selection", () => {
		assert.equal(pathLooksRelated("/repo/project", "/repo/project/subdir"), true);
		assert.equal(pathLooksRelated("/repo/other", "/repo/project"), false);
		assert.equal(
			shouldUseHerdrForCwd({ pane_id: "w1:p1", cwd: "/repo/project", foreground_cwd: null }, "/repo/project/subdir"),
			true,
		);
	});

	it("honors explicit backend preference and supports tmux-first selection", () => {
		assert.equal(parseVisibleBackendPreference("herdr"), "herdr");
		assert.equal(parseVisibleBackendPreference(" tmux "), "tmux");
		assert.equal(parseVisibleBackendPreference("zellij"), null);
		assert.deepEqual(
			chooseVisibleTarget({ herdrPaneId: null, tmuxPaneId: "%39" }),
			{ backend: "tmux", paneId: "%39" },
		);
		assert.deepEqual(
			chooseVisibleTarget({ preferredBackend: "tmux", herdrPaneId: "w1:p2", tmuxPaneId: "%39" }),
			{ backend: "tmux", paneId: "%39" },
		);
		assert.deepEqual(
			chooseVisibleTarget({ preferredBackend: "herdr", herdrPaneId: "w1:p2", tmuxPaneId: "%39" }),
			{ backend: "herdr", paneId: "w1:p2" },
		);
		assert.deepEqual(
			chooseVisibleTarget({ preferredBackend: "herdr", tmuxPaneId: "%39" }),
			{ backend: "tmux", paneId: "%39" },
		);
	});

	it("builds visible user messages and shell scripts", () => {
		assert.equal(
			buildVisibleSubagentUserMessage("worker", ""),
			'Use subagent_visible with agent: "worker", task: "You are the worker agent. Wait for instructions."',
		);
		assert.equal(
			buildVisiblePaneLaunchCommand("/tmp/pi-sub-abc/visible-subagent.sh"),
			"bash '/tmp/pi-sub-abc/visible-subagent.sh'",
		);
		assert.deepEqual(
			buildTmuxVisibleSplitArgs({
				anchorPaneId: "%7",
				cwd: "/repo/project",
				initialCommand: "bash '/tmp/pi-sub-abc/visible-subagent.sh'",
			}),
			[
				"tmux",
				"split-window",
				"-d",
				"-h",
				"-t",
				"%7",
				"-c",
				"/repo/project",
				"-P",
				"-F",
				"#{pane_id}",
				"bash '/tmp/pi-sub-abc/visible-subagent.sh'",
			],
		);
		assert.deepEqual(
			buildTmuxRemainOnExitArgs("%7"),
			["tmux", "set-option", "-pt", "%7", "remain-on-exit", "on"],
		);
		const script = buildVisibleShellScript({
			cwd: "/repo/project",
			commandArgs: ["pi", "hello"],
			exitFile: "/tmp/out.exit",
			env: {
				PI_SUBAGENT_AGENT: "worker",
				PI_SUBAGENT_ALLOWED: "scout,researcher",
			},
		});
		assert.match(script, /export PI_SUBAGENT_AGENT='worker'/);
		assert.match(script, /^'pi' 'hello'$/m);
		assert.match(script, /printf '%s\\n' "\$status" > '\/tmp\/out\.exit'/);
	});

	it("resolves running agents by id or unambiguous name", () => {
		const runs = [
			{ id: "a1", name: "scout:a1", agent: "scout" },
			{ id: "b2", name: "scout:b2", agent: "scout" },
			{ id: "c3", name: "planner:c3", agent: "planner" },
		];
		assert.deepEqual(resolveVisibleRun(runs, { id: "c3" }), { run: runs[2] });
		assert.deepEqual(resolveVisibleRun(runs, { name: "planner" }), { run: runs[2] });
		assert.match(resolveVisibleRun(runs, { name: "scout" }).error ?? "", /Ambiguous/);
		assert.match(resolveVisibleRun(runs, {}).error ?? "", /either `id` or `name`/);
	});

	it("prefers visible execution in TUI mode", async () => {
		let syncCalls = 0;
		const result = await dispatchVisibleFirst({
			mode: "tui",
			preferVisible: true,
			target: { backend: "herdr", paneId: "w1:p2" },
			launchVisible: async () => "visible",
			runSync: async () => { syncCalls++; return "sync"; },
		});
		assert.deepEqual(result, { dispatchMode: "visible", value: "visible" });
		assert.equal(syncCalls, 0);
	});

	it("falls back once when visible execution is unavailable", async () => {
		for (const testCase of [
			{ mode: "rpc", target: { backend: "herdr" as const, paneId: "w1:p2" }, reason: /TUI mode/ },
			{ mode: "tui", target: null, reason: /Herdr\/tmux target/ },
		]) {
			let syncCalls = 0;
			const result = await dispatchVisibleFirst({
				mode: testCase.mode,
				preferVisible: true,
				target: testCase.target,
				launchVisible: async () => "visible",
				runSync: async () => { syncCalls++; return "sync"; },
			});
			assert.equal(result.dispatchMode, "sync-fallback");
			assert.match(result.fallbackReason ?? "", testCase.reason);
			assert.equal(result.value, "sync");
			assert.equal(syncCalls, 1);
		}
	});

	it("falls back once when visible startup throws", async () => {
		let syncCalls = 0;
		const result = await dispatchVisibleFirst({
			mode: "tui",
			preferVisible: true,
			target: { backend: "tmux", paneId: "%7" },
			launchVisible: async () => { throw new Error("split failed"); },
			runSync: async () => { syncCalls++; return "sync"; },
		});
		assert.equal(result.dispatchMode, "sync-fallback");
		assert.match(result.fallbackReason ?? "", /split failed/);
		assert.equal(syncCalls, 1);
	});

	it("runs synchronously without calling visible when explicitly disabled", async () => {
		let visibleCalls = 0;
		const result = await dispatchVisibleFirst({
			mode: "tui",
			preferVisible: false,
			target: { backend: "herdr", paneId: "w1:p2" },
			launchVisible: async () => { visibleCalls++; return "visible"; },
			runSync: async () => "sync",
		});
		assert.deepEqual(result, { dispatchMode: "sync", value: "sync" });
		assert.equal(visibleCalls, 0);
	});
});
