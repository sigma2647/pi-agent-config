/**
 * Tests for the `output:` report contract.
 *
 * The point of `output:` is parent-context economy: a subagent writes its long
 * report to a file and returns only a path plus a short summary. These tests
 * pin the path shape (never inside the caller's working tree), the null case
 * for agents without the contract, and that the shipped roster actually
 * declares it where it should.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../pi-extension/subagents/index.ts";

const { slugifyName, artifactTimestamp, resolveReportPath, buildOutputInstruction, buildSubagentInitialTask, loadAgentDefaults } =
  __test__;

const TS = artifactTimestamp(new Date("2026-09-20T17:31:34.123Z"));

describe("slugifyName", () => {
  it("lowercases and hyphenates", () => {
    assert.equal(slugifyName("Code Reviewer", "subagent"), "code-reviewer");
  });

  it("strips punctuation and collapses hyphens", () => {
    assert.equal(slugifyName("Scout 42!!!", "subagent"), "scout-42");
  });

  it("falls back when nothing survives", () => {
    assert.equal(slugifyName("///", "subagent"), "subagent");
  });
});

describe("artifactTimestamp", () => {
  it("is filesystem safe", () => {
    assert.equal(TS, "2026-09-20T17-31-34");
    assert.ok(!/[:.]/.test(TS));
  });
});

describe("resolveReportPath", () => {
  it("returns null without a declared output", () => {
    assert.equal(resolveReportPath(undefined, "/art", "reviewer", TS), null);
  });

  it("lands in the session artifact dir, not the caller's tree", () => {
    assert.equal(
      resolveReportPath("context.md", "/art", "reviewer", TS),
      "/art/reports/reviewer-2026-09-20T17-31-34-context.md",
    );
  });

  it("ignores any directory part of the declared name", () => {
    const path = resolveReportPath("../../etc/passwd.md", "/art", "scout", TS);
    assert.equal(path, "/art/reports/scout-2026-09-20T17-31-34-passwd.md");
  });
});

describe("buildOutputInstruction", () => {
  const text = buildOutputInstruction("/art/reports/r.md");

  it("names the exact path", () => {
    assert.ok(text.includes("/art/reports/r.md"));
  });

  it("asks for the path on the first line of the summary", () => {
    assert.ok(text.includes("first line is the report path you used"));
  });

  it("lets an explicitly named task path win", () => {
    assert.ok(text.includes("If your task names a report path, prefer that one"));
  });

  it("forbids pasting the report into the summary", () => {
    assert.ok(text.includes("Do not paste the report"));
  });
});

describe("every pi-backed agent knows it can ask the caller", () => {
  // The tool is auto-added to each child's allowlist, but an agent that is
  // never told it exists will guess instead of asking. Only Pi-backed agents
  // are listed: a `cli: claude` agent runs the Claude CLI and has no pi tools.
  for (const agent of ["scout", "researcher", "reviewer", "visual-tester", "worker", "planner"]) {
    it(`${agent} mentions ask_question`, () => {
      const defs = loadAgentDefaults(agent);
      assert.ok(defs?.body, `${agent} has no body`);
      assert.ok(defs.body.includes("ask_question"), `${agent} never mentions ask_question`);
    });
  }
});

describe("buildSubagentInitialTask", () => {
  const base = {
    roleBlock: "\n\nROLE BODY",
    modeHint: "Complete your task autonomously.",
    task: "map the auth module",
    closingInstruction: "REPORT CONTRACT",
  };

  it("carries the closing instruction in standalone mode", () => {
    const msg = buildSubagentInitialTask({ ...base, inheritsConversationContext: false });
    assert.ok(msg.endsWith("REPORT CONTRACT"));
    assert.ok(msg.includes("map the auth module"));
    assert.ok(msg.includes("ROLE BODY"));
  });

  it("carries the closing instruction in fork mode too", () => {
    const msg = buildSubagentInitialTask({ ...base, inheritsConversationContext: true });
    assert.ok(msg.includes("REPORT CONTRACT"));
    assert.ok(msg.includes("map the auth module"));
  });

  it("does not repeat the role body to a fork child", () => {
    const msg = buildSubagentInitialTask({ ...base, inheritsConversationContext: true });
    assert.ok(!msg.includes("ROLE BODY"));
  });
});

describe("shipped roster declares output where it should", () => {
  // Long-form report producers must write to a file; without this they can
  // only dump their whole report into the parent's context window.
  for (const agent of ["scout", "researcher", "reviewer", "visual-tester"]) {
    it(`${agent} declares output`, () => {
      const defs = loadAgentDefaults(agent);
      assert.ok(defs, `${agent} definition not found`);
      assert.ok(defs.output, `${agent} has no output: contract`);
    });
  }

  // Workers return a diff and verification output, not a report file.
  it("worker does not declare output", () => {
    const defs = loadAgentDefaults("worker");
    assert.ok(defs);
    assert.equal(defs.output, undefined);
  });

  // A report writer without `write` can only return prose into the parent.
  for (const agent of ["scout", "researcher", "reviewer", "visual-tester"]) {
    it(`${agent} has write in its tool allowlist`, () => {
      const defs = loadAgentDefaults(agent);
      assert.ok(defs?.tools, `${agent} has no tools allowlist`);
      assert.ok(
        defs.tools.split(",").map((t) => t.trim()).includes("write"),
        `${agent} tools: ${defs.tools}`,
      );
    });
  }
});
