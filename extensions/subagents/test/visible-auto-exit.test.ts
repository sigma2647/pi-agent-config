import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	shouldAutoExitOnAgentEnd,
	shouldMarkUserTookOver,
	parseDeniedTools,
} from "../tools/visible-auto-exit-helpers.ts";
import visibleAutoExit from "../tools/visible-auto-exit.ts";

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

	it("queues one graceful-return steering message for repeated shortcut presses", () => {
		const shortcuts = new Map<string, { handler: (ctx: unknown) => void }>();
		const sent: Array<{ content: string; options: unknown }> = [];
		const pi = {
			getAllTools: () => [],
			on: () => {},
			registerTool: () => {},
			registerShortcut: (key: string, options: { handler: (ctx: unknown) => void }) => shortcuts.set(key, options),
			sendUserMessage: (content: string, options: unknown) => sent.push({ content, options }),
		};
		const ctx = { ui: { setWidget: () => {} } };

		visibleAutoExit(pi as never);
		shortcuts.get("ctrl+shift+s")?.handler(ctx);
		shortcuts.get("ctrl+shift+s")?.handler(ctx);

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]?.options, { deliverAs: "steer" });
		assert.match(sent[0]?.content ?? "", /Stop starting new searches or tool calls/);
		assert.match(sent[0]?.content ?? "", /incomplete or uncertain items/);
	});

	it("parses displayable denied-tool names", () => {
		assert.deepEqual(parseDeniedTools(" subagent, , claude "), ["subagent", "claude"]);
	});
});
