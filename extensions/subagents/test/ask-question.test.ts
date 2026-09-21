/**
 * Tests for the child-to-parent question channel.
 *
 * The point of `ask_question` is that the child PARKS instead of exiting, and
 * that the question is durable: it lives in an on-disk queue until the answer
 * has been sent, so a parent restart does not lose it. These tests pin the
 * sidecar payload, the queue, the auto-exit guard, the pane-safe message
 * flattening, the reply text, and the durable name registry.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  ASK_QUEUE_SUFFIX,
  appendAskRequest,
  askQueuePath,
  clearAskQueue,
  parseAskQueue,
  readAskQueue,
} from "../pi-extension/subagents/ask-queue.ts";

const {
  flattenForPane,
  formatAskSteerContent,
  findRunningSubagentByName,
  findRunningSubagentsByName,
  rememberFinishedSubagent,
  subagentRegistryPath,
  readSubagentRegistry,
  writeSubagentRegistryEntry,
  runningSubagents,
  finishedSubagents,
} = __test__;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ask-queue-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildAskPayload", () => {
  it("trims the question and carries the id the parent echoes back", () => {
    const request = buildAskPayload("worker", "  v1 or v2?  ", "req-1");
    assert.equal(request.id, "req-1");
    assert.equal(request.name, "worker");
    assert.equal(request.question, "v1 or v2?");
  });

  it("falls back to a generic name", () => {
    assert.equal(buildAskPayload("", "help", "req-2").name, "subagent");
  });

  it("refuses an empty question", () => {
    assert.throws(() => buildAskPayload("worker", "   ", "req-3"), /non-empty question/);
  });
});

describe("askQuestionToolResult", () => {
  it("tells the child to park rather than guess", () => {
    const text = askQuestionToolResult("worker", "req-9").content[0].text;
    assert.match(text, /stays open/);
    assert.match(text, /req-9/);
    assert.match(text, /end your turn/);
    assert.match(text, /Do not guess/);
  });
});

describe("ask queue", () => {
  it("sits next to the child session file", () => {
    assert.equal(askQueuePath("/tmp/child.jsonl"), `/tmp/child.jsonl${ASK_QUEUE_SUFFIX}`);
  });

  it("reads as empty when the file is missing", () => {
    assert.deepEqual(readAskQueue(join(dir, "nothing.asks.json")), []);
  });

  it("keeps every question asked in the same turn", () => {
    const path = askQueuePath(join(dir, "child.jsonl"));
    appendAskRequest(path, buildAskPayload("worker", "first?", "a"));
    appendAskRequest(path, buildAskPayload("worker", "second?", "b"));

    assert.deepEqual(
      readAskQueue(path).map((request) => request.question),
      ["first?", "second?"],
    );
  });

  it("is only cleared once the answer has been sent", () => {
    const path = askQueuePath(join(dir, "child.jsonl"));
    appendAskRequest(path, buildAskPayload("worker", "still waiting?", "a"));
    assert.equal(readAskQueue(path).length, 1);

    clearAskQueue(path);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readAskQueue(path), []);
  });

  it("survives a corrupt queue file", () => {
    const path = askQueuePath(join(dir, "child.jsonl"));
    writeFileSync(path, "{not json", "utf8");
    assert.deepEqual(readAskQueue(path), []);
  });

  it("drops entries without a question and tolerates a missing id", () => {
    assert.deepEqual(parseAskQueue({}), []);
    assert.deepEqual(parseAskQueue([{ question: "  " }]), []);
    const [kept] = parseAskQueue([{ name: "w", question: "keep me", at: "2026-01-01T00:00:00Z" }]);
    assert.equal(kept.question, "keep me");
    assert.equal(kept.id, "2026-01-01T00:00:00Z");
  });
});

describe("subagent registry", () => {
  it("upserts one child without touching the others", () => {
    const path = subagentRegistryPath(dir);
    writeSubagentRegistryEntry(path, {
      name: "Worker",
      sessionFile: "/tmp/w.jsonl",
      status: "running",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    writeSubagentRegistryEntry(path, {
      name: "Scout",
      sessionFile: "/tmp/s.jsonl",
      status: "finished",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    writeSubagentRegistryEntry(path, {
      name: "Worker",
      sessionFile: "/tmp/w.jsonl",
      status: "parked",
      surface: "w1:p2",
      updatedAt: "2026-01-01T00:01:00Z",
    });

    const entries = readSubagentRegistry(path);
    assert.equal(entries.Worker.status, "parked");
    assert.equal(entries.Worker.surface, "w1:p2");
    assert.equal(entries.Scout.status, "finished");
  });

  it("reads as empty when missing or corrupt", () => {
    assert.deepEqual(readSubagentRegistry(join(dir, "none.json")), {});
    writeFileSync(subagentRegistryPath(dir), "{not json", "utf8");
    assert.deepEqual(readSubagentRegistry(subagentRegistryPath(dir)), {});
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
  it("names the request, the child and the reply tool", () => {
    const text = formatAskSteerContent(
      { id: "req-7", name: "worker", question: "v1 or v2?", at: "" },
      "/tmp/s.jsonl",
    );
    assert.match(text, /"worker" is waiting/);
    assert.match(text, /request req-7/);
    assert.match(text, /v1 or v2\?/);
    assert.match(text, /subagent_message\(\{ name: "worker"/);
    assert.match(text, /\/tmp\/s\.jsonl/);
  });

  it("omits the session block when there is no session file", () => {
    const text = formatAskSteerContent({ id: "r", name: "w", question: "?", at: "" });
    assert.doesNotMatch(text, /Session:/);
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

describe("a parked child", () => {
  const ENV_KEYS = ["PI_SUBAGENT_AUTO_EXIT", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_NAME"] as const;

  it("survives the model request that follows the ask, then exits once the reply lands", async () => {
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

      const queue = readAskQueue(askQueuePath(sessionFile));
      assert.equal(queue.length, 1, "the question should be queued on disk");
      assert.equal(queue[0].question, "v1 or v2?");
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
      assert.equal(
        readFileSync(askQueuePath(sessionFile), "utf8").includes("v1 or v2?"),
        true,
        "the queue is the parent's to clear, not the child's",
      );
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
