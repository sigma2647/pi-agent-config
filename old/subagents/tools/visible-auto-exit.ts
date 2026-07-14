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

// Use Ctrl+Shift+J instead of Ctrl+J to avoid conflicting with Pi's built-in
// tui.input.newLine shortcut. Ctrl+J must remain available for inserting
// newlines in the text input. Legacy terminals that cannot distinguish
// Ctrl+Shift+J from Ctrl+J simply won't see the widget toggle.
const TOOL_WIDGET_SHORTCUT = "ctrl+shift+j";
const TOOL_WIDGET_SHORTCUT_LABEL = "Ctrl+Shift+J";

const GRACEFUL_RETURN_SHORTCUT = "ctrl+shift+s";
const GRACEFUL_RETURN_SHORTCUT_LABEL = "Ctrl+Shift+S";
const GRACEFUL_RETURN_PROMPT =
	"Stop starting new searches or tool calls. Using only information already obtained, provide a concise final report for the parent agent with: completed work, main findings, and any incomplete or uncertain items. Treat that report as your final response.";

export default function (pi: ExtensionAPI) {
	const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
	const exitFile = process.env.PI_VISIBLE_SUBAGENT_EXIT_FILE;
	const pingFile = process.env.PI_VISIBLE_SUBAGENT_PING_FILE;
	const agentName = process.env.PI_SUBAGENT_AGENT ?? process.env.PI_SUBAGENT_NAME ?? "";
	const denied = parseDeniedTools(process.env.PI_DENY_TOOLS);
	let userTookOver = false;
	let agentStarted = false;
	let expanded = false;
	let gracefulReturnRequested = false;

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
					const controls = gracefulReturnRequested
						? `${TOOL_WIDGET_SHORTCUT_LABEL} to collapse · return requested · Esc abort`
						: `${TOOL_WIDGET_SHORTCUT_LABEL} to collapse · ${GRACEFUL_RETURN_SHORTCUT_LABEL} summarize & return · Esc abort`;
					box.addChild(new Text(
						`${label}${theme.fg("dim", ` — ${tools.length} available`)}${theme.fg("muted", `  (${controls})`)}\n${toolList}${deniedLine}`,
						0,
						0,
					));
				} else {
					const deniedInfo = denied.length
						? `${theme.fg("dim", " · ")}${theme.fg("error", `${denied.length} denied`)}`
						: "";
					const controls = gracefulReturnRequested
						? `${TOOL_WIDGET_SHORTCUT_LABEL} to expand · return requested · Esc abort`
						: `${TOOL_WIDGET_SHORTCUT_LABEL} to expand · ${GRACEFUL_RETURN_SHORTCUT_LABEL} summarize & return · Esc abort`;
					box.addChild(new Text(
						`${label}${theme.fg("dim", ` — ${tools.length} tools`)}${deniedInfo}${theme.fg("muted", `  (${controls})`)}`,
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
		(pi as any).registerShortcut(GRACEFUL_RETURN_SHORTCUT, {
			description: "Summarize current work and return to parent",
			handler: (ctx: any) => {
				if (gracefulReturnRequested) return;
				gracefulReturnRequested = true;
				renderWidget(ctx);
				pi.sendUserMessage(GRACEFUL_RETURN_PROMPT, { deliverAs: "steer" });
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
		if (!shouldAutoExitOnAgentEnd(autoExit, userTookOver, gracefulReturnRequested, event.messages)) return;
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
