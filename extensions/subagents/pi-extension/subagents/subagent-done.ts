/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Auto-exit agents shut down after their final assistant message via agent_end
 * - Interactive agents get `subagent_done` for explicit completion
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * A child that asked a question must not auto-exit: its pane has to stay open
 * so the parent can deliver the answer as the next user message.
 */
export function shouldAutoExitAfterTurn(opts: {
  autoExit: boolean;
  waitingForParent: boolean;
  userTookOver: boolean;
  messages: any[] | undefined;
}): boolean {
  if (!opts.autoExit) return false;
  if (opts.waitingForParent) return false;
  return shouldAutoExitOnAgentEnd(opts.userTookOver, opts.messages);
}

/**
 * Any tool call other than the ask tools means the model kept working instead
 * of parking, so the waiting state must not block the eventual auto-exit.
 *
 * Do NOT add `turn_start` here: a turn is one model request, so the request
 * that produces the message AFTER the ask_question call starts a new turn and
 * would clear the waiting state before agent_end ever sees it. The answer
 * arriving is signalled by the `input` event instead.
 */
export function shouldClearWaitingOnToolStart(toolName: string): boolean {
  return toolName !== "ask_question" && toolName !== "caller_ping";
}

/**
 * Build the `<sessionFile>.ask` payload the parent watcher reads.
 * Throws when there is no question to send.
 */
export function buildAskPayload(name: string, question: string): {
  type: "ask";
  name: string;
  question: string;
  at: string;
} {
  const trimmed = (question ?? "").trim();
  if (!trimmed) throw new Error("ask_question requires a non-empty question.");
  return {
    type: "ask",
    name: name || "subagent",
    question: trimmed,
    at: new Date().toISOString(),
  };
}

/**
 * Text returned to the child after it asks. The child must stop here: the
 * answer arrives later as an ordinary user message in this same session.
 */
export function askQuestionToolResult(name: string) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Question sent to the parent as "${name}". Your pane stays open and your session is parked.\n\n` +
          `Stop here: end your turn now with a one-line note that you are waiting for the answer. ` +
          `Do not guess an answer and do not start other work. ` +
          `The reply will arrive as your next user message, and you continue from where you stopped.`,
      },
    ],
    details: { status: "waiting_for_parent", name },
  };
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  /** True while the child is parked with an unanswered question. */
  let waitingForParent = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // A user message arrived in this session. The only way that can happen
    // while parked is the parent answering (or a human typing), so the wait is
    // over. This must not move to `turn_start`: that fires again for the model
    // request that follows the ask, which would clear the state too early.
    waitingForParent = false;
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit = shouldAutoExitAfterTurn({
      autoExit,
      waitingForParent,
      userTookOver,
      messages,
    });

    if (shouldExit) {
      // Always notify the parent via the .exit sidecar before shutdown so
      // normal completion does not depend on backend-specific terminal capture.
      // Preserve stopReason: "error" details for a clear failure report.
      const errorInfo = findLatestAssistantError(messages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        try {
          writeFileSync(
            `${sessionFile}.exit`,
            JSON.stringify(errorInfo
              ? {
                  type: "error",
                  errorMessage: errorInfo.errorMessage,
                  stopReason: errorInfo.stopReason,
                }
              : { type: "done" }),
          );
        } catch {
          // Best effort — the watcher can still fall back to the terminal sentinel.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    const toolName = (event as any).toolName;
    if (shouldClearWaitingOnToolStart(toolName)) waitingForParent = false;
    recorder.toolExecutionStart((event as any).toolCallId, toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  const askToolDescription =
    "Ask the parent agent a question and WAIT for the answer instead of guessing. " +
    "This session stays open and parked; the reply arrives as your next user message. " +
    "Use it only for decisions or facts you cannot settle yourself — then end your turn.";

  function askParentAndPark(question: string) {
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (!sessionFile) {
      throw new Error(
        "ask_question is only available in subagent contexts. " +
          "PI_SUBAGENT_SESSION environment variable is not set.",
      );
    }

    const name = process.env.PI_SUBAGENT_NAME ?? "subagent";
    const payload = buildAskPayload(name, question);
    recorder.callerPing();
    // Non-terminal sidecar: the parent watcher picks it up and keeps polling.
    // Unlike `.exit`, this must NOT shut the session down.
    writeFileSync(`${sessionFile}.ask`, JSON.stringify(payload), "utf8");
    waitingForParent = true;
    return askQuestionToolResult(name);
  }

  pi.registerTool({
    name: "ask_question",
    label: "Ask Parent",
    description: askToolDescription,
    parameters: Type.Object({
      question: Type.String({
        description: "The question for the parent agent, with the context it needs to answer.",
      }),
    }),
    async execute(_toolCallId, params) {
      return askParentAndPark(params.question);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Alias of ask_question, kept for existing agent prompts. " +
      "Sends the message to the parent and parks this session until the reply arrives. " +
      "It no longer exits the session.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params) {
      return askParentAndPark(params.message);
    },
  });

  // Auto-exit agents already shut down in agent_end, after the model's final
  // assistant message is complete. Exposing subagent_done lets the model call
  // it one turn too early and return a planning sentence instead of its report.
  if (!autoExit) {
    pi.registerTool({
      name: "subagent_done",
      label: "Subagent Done",
      description:
        "Call this tool when you have completed your task. " +
        "It will close this session and return your results to the main session. " +
        "Your LAST assistant message before calling this becomes the summary returned to the caller.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const sessionFile = process.env.PI_SUBAGENT_SESSION;
        recorder.subagentDone();
        if (sessionFile) {
          writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
        }
        ctx.shutdown();
        return {
          content: [{ type: "text", text: "Shutting down subagent session." }],
          details: {},
        };
      },
    });
  }
}
