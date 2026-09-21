/**
 * Tests for the child-to-parent question channel.
 *
 * The point of `ask_question` is that the child PARKS instead of exiting: its
 * pane stays open, the parent answers with `subagent_message`, and the child
 * continues from where it stopped. These tests pin the pieces that decide that
 * behaviour — the sidecar payload, the auto-exit guard, the pane-safe message
 * flattening, and the reply text handed to the parent.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __test__ } from "../pi-extension/subagents/index.ts";
import subagentDoneExtension, {
  buildAskPayload,
  askQuestionToolResult,
  shouldAutoExitAfterTurn,
  shouldClearWaitingOnToolStart,
  shouldAutoExitOnAgentEnd,
} from "../pi-extension/subagents/subagent-done.ts";
import { readAskSidecar } from "../pi-extension/subagents/cmux.ts";

const {
  flattenForPane,
  formatAskSteerContent,
  findRunningSubagentByName,
  findRunningSubagentsByName,
  rememberFinishedSubagent,
  runningSubagents,
  finishedSubagents,
} = __test__;

describe("buildAskPayload", () => {
  it("trims the question and tags the sidecar as an ask", () => {
    const payload = buildAskPayload("worker", "  v1 or v2?  ");
    assert.equal(payload.type, "ask");
    assert.equal(payload.name, "worker");
    assert.equal(payload.question, "v1 or v2?");
  });

  it("falls back to a generic name", () => {
    assert.equal(buildAskPayload("", "help").name, "subagent");
  });

  it("refuses an empty question", () => {
    assert.throws(() => buildAskPayload("worker", "   "), /non-empty question/);
  });
});

describe("askQuestionToolResult", () => {
  it("tells the child to park rather than guess", () => {
    const text = askQuestionToolResult("worker").content[0].text;
    assert.match(text, /stays open/);
    assert.match(text, /end your turn/);
    assert.match(text, /Do not guess/);
  });
});

describe("shouldAutoExitAfterTurn", () => {
  const normalTurn = [{ role: "assistant", stopReason: "stop" }];

  it("blocks auto-exit while the child waits for an answer", () => {
    assert.equal(
      shouldAutoExitAfterTurn({
        autoExit: true,
        waitingForParent: true,
        userTookOver: false,
        messages: normalTurn,
      }),
      false,
    );
  });

  it("exits a normal turn once the child is no longer waiting", () => {
    assert.equal(
      shouldAutoExitAfterTurn({
        autoExit: true,
        waitingForParent: false,
        userTookOver: false,
        messages: normalTurn,
      }),
      true,
    );
  });

  it("never auto-exits an interactive child", () => {
    assert.equal(
      shouldAutoExitAfterTurn({
        autoExit: false,
        waitingForParent: false,
        userTookOver: false,
        messages: normalTurn,
      }),
      false,
    );
  });

  it("still honours the abort and error rules from the base predicate", () => {
    assert.equal(shouldAutoExitOnAgentEnd(false, [{ role: "assistant", stopReason: "aborted" }]), false);
    assert.equal(shouldAutoExitOnAgentEnd(false, [{ role: "assistant", stopReason: "error" }]), true);
  });
});

describe("shouldClearWaitingOnToolStart", () => {
  it("keeps waiting through the ask tools themselves", () => {
    assert.equal(shouldClearWaitingOnToolStart("ask_question"), false);
    assert.equal(shouldClearWaitingOnToolStart("caller_ping"), false);
  });

  it("clears waiting when the model kept working instead of parking", () => {
    assert.equal(shouldClearWaitingOnToolStart("read"), true);
    assert.equal(shouldClearWaitingOnToolStart("bash"), true);
  });
});

describe("flattenForPane", () => {
  it("collapses newlines so the message is not submitted early", () => {
    assert.equal(flattenForPane("Use v2.\n\nAlso run the tests."), "Use v2. Also run the tests.");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(flattenForPane("  answer  "), "answer");
  });

  it("returns an empty string for an empty message", () => {
    assert.equal(flattenForPane("   \n  "), "");
  });
});

describe("formatAskSteerContent", () => {
  it("names the reply tool and the child", () => {
    const text = formatAskSteerContent({ name: "worker", question: "v1 or v2?" }, "/tmp/s.jsonl");
    assert.match(text, /"worker" is waiting/);
    assert.match(text, /v1 or v2\?/);
    assert.match(text, /subagent_message\(\{ name: "worker"/);
    assert.match(text, /\/tmp\/s\.jsonl/);
  });

  it("omits the session block when there is no session file", () => {
    assert.doesNotMatch(formatAskSteerContent({ name: "w", question: "?" }), /Session:/);
  });
});

describe("readAskSidecar", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ask-sidecar-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a valid ask", () => {
    const path = join(dir, "s.jsonl.ask");
    writeFileSync(path, JSON.stringify({ type: "ask", name: "worker", question: "v1 or v2?" }));
    assert.deepEqual(readAskSidecar(path), { name: "worker", question: "v1 or v2?" });
  });

  it("returns null when the file is missing", () => {
    assert.equal(readAskSidecar(join(dir, "nothing.ask")), null);
  });

  it("ignores a payload that is not an ask", () => {
    const path = join(dir, "s.jsonl.ask");
    writeFileSync(path, JSON.stringify({ type: "done" }));
    assert.equal(readAskSidecar(path), null);
  });

  it("ignores an unreadable or empty payload", () => {
    const path = join(dir, "s.jsonl.ask");
    writeFileSync(path, "{not json");
    assert.equal(readAskSidecar(path), null);
    writeFileSync(path, JSON.stringify({ type: "ask", question: "   " }));
    assert.equal(readAskSidecar(path), null);
  });
});

describe("a parked child", () => {
  const ENV_KEYS = ["PI_SUBAGENT_AUTO_EXIT", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_NAME"] as const;

  it("survives the model request that follows the ask, then exits once the reply lands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-park-"));
    const sessionFile = join(dir, "child.jsonl");
    const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);

    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_NAME = "worker";

    const tools: any[] = [];
    const handlers = new Map<string, Function>();
    let shutdown = false;

    try {
      subagentDoneExtension({
        on(event: string, handler: Function) {
          handlers.set(event, handler);
        },
        getAllTools() {
          return [];
        },
        registerShortcut() {},
        registerTool(tool: any) {
          tools.push(tool);
        },
      } as any);

      const ask = tools.find((tool) => tool.name === "ask_question");
      assert.ok(ask, "ask_question should be registered");
      await ask.execute("call-1", { question: "v1 or v2?" });

      assert.ok(existsSync(`${sessionFile}.ask`), "ask sidecar should be written");
      assert.equal(existsSync(`${sessionFile}.exit`), false, "asking must not exit the child");

      // A turn is ONE model request, so the request that produces the message
      // AFTER the ask_question call starts a new turn. Clearing the parked
      // state there is the bug that made children exit before being answered.
      handlers.get("turn_start")!({ turnIndex: 1 });

      const ctx = { shutdown: () => { shutdown = true; } };
      const normalTurn = { messages: [{ role: "assistant", stopReason: "stop" }] };
      handlers.get("agent_end")!(normalTurn, ctx);

      assert.equal(shutdown, false, "a parked child must not auto-exit");
      assert.equal(existsSync(`${sessionFile}.exit`), false, "no done sidecar while parked");

      // The parent's reply arrives as a user message in this same session.
      handlers.get("input")!({});
      handlers.get("agent_end")!(normalTurn, ctx);

      assert.equal(shutdown, true, "once answered, the child exits normally");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findRunningSubagentByName", () => {
  afterEach(() => {
    runningSubagents.clear();
    finishedSubagents.clear();
  });

  it("finds an exact name, accepts different casing, and misses cleanly", () => {
    runningSubagents.set("abc", { id: "abc", name: "Worker" } as any);
    assert.equal(findRunningSubagentByName("Worker")?.id, "abc");
    assert.equal(findRunningSubagentByName("worker")?.id, "abc");
    assert.equal(findRunningSubagentByName("reviewer"), undefined);
  });

  it("refuses to pick one when two subagents share a name", () => {
    runningSubagents.set("abc", { id: "abc", name: "Worker" } as any);
    runningSubagents.set("def", { id: "def", name: "Worker" } as any);

    assert.equal(findRunningSubagentByName("Worker"), undefined);
    assert.deepEqual(
      findRunningSubagentsByName("Worker").map((entry) => entry.id),
      ["abc", "def"],
    );
  });
});

describe("rememberFinishedSubagent", () => {
  afterEach(() => {
    finishedSubagents.clear();
  });

  it("keeps the cli so a Claude-backed child is not resumed as a pi session", () => {
    rememberFinishedSubagent({ name: "Pi", sessionFile: "/tmp/a.jsonl" } as any);
    rememberFinishedSubagent({ name: "Claude", sessionFile: "/tmp/b.jsonl", cli: "claude" } as any);

    assert.equal(finishedSubagents.get("Pi")?.cli, undefined);
    assert.equal(finishedSubagents.get("Claude")?.cli, "claude");
  });

  it("ignores a run that never wrote a session file", () => {
    rememberFinishedSubagent({ name: "NoSession", sessionFile: "" } as any);
    assert.equal(finishedSubagents.has("NoSession"), false);
  });
});
