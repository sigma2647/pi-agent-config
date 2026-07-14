import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildSubagentChildEnv,
	buildSubagentUserMessage,
	getSelfSpawnError,
	parseSubagentCommandArgs,
} from "../helpers.ts";

describe("subagents helpers", () => {
	it("parses /subagent args with optional task", () => {
		assert.deepEqual(parseSubagentCommandArgs("worker fix the failing test"), {
			agentName: "worker",
			task: "fix the failing test",
		});
		assert.deepEqual(parseSubagentCommandArgs("scout"), {
			agentName: "scout",
			task: "",
		});
		assert.deepEqual(parseSubagentCommandArgs("   "), {
			task: "",
		});
	});

	it("builds a user message with a default waiting task", () => {
		assert.equal(
			buildSubagentUserMessage("scout", ""),
			'Use subagent with agent: "scout", task: "You are the scout agent. Wait for instructions."',
		);
		assert.equal(
			buildSubagentUserMessage("worker", 'check "quoted" input'),
			'Use subagent with agent: "worker", task: "check \\"quoted\\" input"',
		);
	});

	it("blocks self-spawn but allows other agents", () => {
		assert.match(getSelfSpawnError("worker", "worker") || "", /do not start another worker/);
		assert.equal(getSelfSpawnError("worker", "scout"), null);
		assert.equal(getSelfSpawnError(undefined, "worker"), null);
	});

	it("builds child env with agent identity and clears stale allowlists", () => {
		const restricted = buildSubagentChildEnv(
			{ PATH: "/usr/bin" },
			{ name: "worker", tools: ["read", "subagent"], subagentAgents: ["scout", "researcher"] },
		);
		assert.equal(restricted.PI_SUBAGENT_AGENT, "worker");
		assert.equal(restricted.PI_SUBAGENT_ALLOWED, "scout,researcher");

		const unrestricted = buildSubagentChildEnv(
			{ PATH: "/usr/bin", PI_SUBAGENT_ALLOWED: "stale" },
			{ name: "scout", tools: ["read", "grep"] },
		);
		assert.equal(unrestricted.PI_SUBAGENT_AGENT, "scout");
		assert.equal("PI_SUBAGENT_ALLOWED" in unrestricted, false);
	});
});
