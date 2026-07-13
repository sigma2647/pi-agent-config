import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	shouldAutoExitOnAgentEnd,
	shouldMarkUserTookOver,
	parseDeniedTools,
} from "../tools/visible-auto-exit-helpers.ts";

describe("visible subagent auto-exit", () => {
	it("ignores the initial CLI task but recognizes later pane input", () => {
		assert.equal(shouldMarkUserTookOver(false), false);
		assert.equal(shouldMarkUserTookOver(true), true);
	});

	it("closes autonomous work and requested graceful returns after a non-aborted assistant turn", () => {
		assert.equal(shouldAutoExitOnAgentEnd(true, false, false, [{ role: "assistant", stopReason: "stop" }]), true);
		assert.equal(shouldAutoExitOnAgentEnd(true, true, false, [{ role: "assistant", stopReason: "stop" }]), true);
		assert.equal(shouldAutoExitOnAgentEnd(true, false, false, [{ role: "assistant", stopReason: "aborted" }]), false);
		assert.equal(shouldAutoExitOnAgentEnd(false, false, true, [{ role: "assistant", stopReason: "stop" }]), true);
		assert.equal(shouldAutoExitOnAgentEnd(false, false, true, [{ role: "assistant", stopReason: "aborted" }]), false);
		assert.equal(shouldAutoExitOnAgentEnd(false, false, false, [{ role: "assistant", stopReason: "stop" }]), false);
	});

	it("parses displayable denied-tool names", () => {
		assert.deepEqual(parseDeniedTools(" subagent, , claude "), ["subagent", "claude"]);
	});
});
