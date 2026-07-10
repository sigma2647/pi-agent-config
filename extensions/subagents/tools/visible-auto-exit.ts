import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	parseDeniedTools,
	shouldAutoExitOnAgentEnd,
	shouldMarkUserTookOver,
} from "./visible-auto-exit-helpers.ts";

export { parseDeniedTools, shouldAutoExitOnAgentEnd, shouldMarkUserTookOver } from "./visible-auto-exit-helpers.ts";

// In legacy terminal input Ctrl+Shift+J is indistinguishable from Ctrl+J.
// Use the latter so the widget works outside terminals that support Kitty's
// extended keyboard protocol.
const TOOL_WIDGET_SHORTCUT = "ctrl+j";
const TOOL_WIDGET_SHORTCUT_LABEL = "Ctrl+J";

export default function (pi: ExtensionAPI) {
	const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
	const exitFile = process.env.PI_VISIBLE_SUBAGENT_EXIT_FILE;
	const pingFile = process.env.PI_VISIBLE_SUBAGENT_PING_FILE;
	const agentName = process.env.PI_SUBAGENT_AGENT ?? process.env.PI_SUBAGENT_NAME ?? "";
	const denied = parseDeniedTools(process.env.PI_DENY_TOOLS);
	let userTookOver = false;
	let agentStarted = false;
	let expanded = false;

	function renderWidget(ctx: { ui: { setWidget: Function } }) {
		const tools = typeof (pi as any).getAllTools === "function"
			? (pi as any).getAllTools().map((tool: { name: string }) => tool.name).sort()
			: [];
		ctx.ui.setWidget(
			"subagent-tools",
			(_tui: unknown, theme: any) => {
				const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));
				const label = agentName ? theme.bold(theme.fg("accent", `[${agentName}]`)) : "";
				if (expanded) {
					const toolList = tools.map((name: string) => theme.fg("dim", name)).join(theme.fg("muted", ", "));
					const deniedLine = denied.length
						? `\n${theme.fg("muted", "denied: ")}${denied.map((name) => theme.fg("error", name)).join(theme.fg("muted", ", "))}`
						: "";
					box.addChild(new Text(
						`${label}${theme.fg("dim", ` — ${tools.length} available`)}${theme.fg("muted", `  (${TOOL_WIDGET_SHORTCUT_LABEL} to collapse)`)}\n${toolList}${deniedLine}`,
						0,
						0,
					));
				} else {
					const deniedInfo = denied.length
						? `${theme.fg("dim", " · ")}${theme.fg("error", `${denied.length} denied`)}`
						: "";
					box.addChild(new Text(
						`${label}${theme.fg("dim", ` — ${tools.length} tools`)}${deniedInfo}${theme.fg("muted", `  (${TOOL_WIDGET_SHORTCUT_LABEL} to expand)`)}`,
						0,
						0,
					));
				}
				return box;
			},
			{ placement: "aboveEditor" },
		);
	}

	pi.on("session_start", (_event, ctx) => renderWidget(ctx as any));
	if (typeof (pi as any).registerShortcut === "function") {
		(pi as any).registerShortcut(TOOL_WIDGET_SHORTCUT, {
			description: "Toggle subagent tools widget",
			handler: (ctx: any) => {
				expanded = !expanded;
				renderWidget(ctx);
			},
		});
	}

	pi.on("input", () => {
		// The CLI task arrives as input before the first run; only later pane input is takeover.
		if (shouldMarkUserTookOver(agentStarted)) userTookOver = true;
	});

	pi.on("agent_start", () => {
		agentStarted = true;
	});

	pi.on("agent_end", (event, ctx) => {
		if (!shouldAutoExitOnAgentEnd(autoExit, userTookOver, event.messages)) return;
		if (exitFile) {
			try {
				writeFileSync(exitFile, "done\n");
			} catch {}
		}
		ctx.shutdown();
	});

	pi.registerTool({
		name: "caller_ping",
		label: "Caller Ping",
		description: "Ask the parent agent for help, then close this visible subagent session.",
		parameters: Type.Object({ message: Type.String({ description: "What you need from the parent" }) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!pingFile) throw new Error("caller_ping is only available in visible subagent contexts.");
			writeFileSync(pingFile, JSON.stringify({ message: params.message }));
			if (exitFile) writeFileSync(exitFile, "done\n");
			ctx.shutdown();
			return { content: [{ type: "text", text: "Help request sent to the parent." }], details: {} };
		},
	});

	pi.registerTool({
		name: "subagent_done",
		label: "Subagent Done",
		description: "Finish this session and return the final assistant message to the parent.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (exitFile) writeFileSync(exitFile, "done\n");
			ctx.shutdown();
			return { content: [{ type: "text", text: "Closing subagent session." }], details: {} };
		},
	});
}
