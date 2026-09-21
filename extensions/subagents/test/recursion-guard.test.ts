/**
 * Tests for the spawn-depth cap.
 *
 * Every child is a fresh pi process, and `spawning` is on by default, so without
 * a cap a chain of custom agents can nest forever: each level costs tokens and
 * nothing stops it. Depth is the hard stop. It travels in the environment so a
 * chain keeps its level across process boundaries, and it is applied on top of
 * `spawning: false` rather than instead of it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../pi-extension/subagents/index.ts";

const {
  resolveDenyTools,
  resolveSubagentDepth,
  resolveMaxSubagentDepth,
  shouldDenySpawning,
  DEFAULT_MAX_SUBAGENT_DEPTH,
} = __test__;

const SPAWNING_TOOLS = [
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
  "subagent_message",
];

describe("resolveSubagentDepth", () => {
  it("treats a session with no depth set as the top level", () => {
    assert.equal(resolveSubagentDepth({}), 0);
  });

  it("reads the level a parent passed down", () => {
    assert.equal(resolveSubagentDepth({ PI_SUBAGENT_DEPTH: "2" }), 2);
  });

  it("falls back to the top level for garbage instead of guessing", () => {
    for (const raw of ["", " ", "two", "-1", "1.5", "NaN"]) {
      assert.equal(resolveSubagentDepth({ PI_SUBAGENT_DEPTH: raw }), 0, `raw=${JSON.stringify(raw)}`);
    }
  });
});

describe("resolveMaxSubagentDepth", () => {
  it("defaults to two levels below the top-level session", () => {
    assert.equal(resolveMaxSubagentDepth({}), DEFAULT_MAX_SUBAGENT_DEPTH);
    assert.equal(DEFAULT_MAX_SUBAGENT_DEPTH, 2);
  });

  it("honours an explicit limit, including zero", () => {
    assert.equal(resolveMaxSubagentDepth({ PI_SUBAGENT_MAX_DEPTH: "1" }), 1);
    assert.equal(resolveMaxSubagentDepth({ PI_SUBAGENT_MAX_DEPTH: "0" }), 0);
  });

  it("falls back for garbage and for an empty value", () => {
    assert.equal(
      resolveMaxSubagentDepth({ PI_SUBAGENT_MAX_DEPTH: "deep" }),
      DEFAULT_MAX_SUBAGENT_DEPTH,
    );
    assert.equal(resolveMaxSubagentDepth({ PI_SUBAGENT_MAX_DEPTH: "" }), DEFAULT_MAX_SUBAGENT_DEPTH);
  });
});

describe("shouldDenySpawning", () => {
  it("allows a session below the limit and blocks one at or past it", () => {
    assert.equal(shouldDenySpawning(0, 2), false);
    assert.equal(shouldDenySpawning(1, 2), false);
    assert.equal(shouldDenySpawning(2, 2), true);
    assert.equal(shouldDenySpawning(3, 2), true);
  });

  it("blocks the top level itself when the limit is zero", () => {
    assert.equal(shouldDenySpawning(0, 0), true);
  });
});

describe("resolveDenyTools and the depth cap", () => {
  it("denies every spawning tool once the chain reaches the limit", () => {
    const denied = resolveDenyTools(null, 2, 2);
    for (const tool of SPAWNING_TOOLS) {
      assert.equal(denied.has(tool), true, `${tool} should be denied at the limit`);
    }
  });

  it("denies nothing below the limit when the agent says nothing", () => {
    assert.equal(resolveDenyTools(null, 1, 2).size, 0);
    assert.equal(resolveDenyTools({}, 0, 2).size, 0);
  });

  it("still expands spawning: false below the limit", () => {
    const denied = resolveDenyTools({ spawning: false }, 1, 2);
    for (const tool of SPAWNING_TOOLS) {
      assert.equal(denied.has(tool), true, `${tool} should be denied by frontmatter`);
    }
  });

  it("keeps deny-tools entries and adds the cap on top", () => {
    const denied = resolveDenyTools({ denyTools: "read, write" }, 2, 2);
    assert.equal(denied.has("read"), true);
    assert.equal(denied.has("write"), true);
    for (const tool of SPAWNING_TOOLS) {
      assert.equal(denied.has(tool), true, `${tool} should be denied by the cap`);
    }
  });

  it("does not deny a non-spawning tool just because the cap hit", () => {
    const denied = resolveDenyTools({ denyTools: "" }, 5, 2);
    assert.equal(denied.has("read"), false);
    assert.equal(denied.size, SPAWNING_TOOLS.length);
  });

  it("defaults to the top level, so an omitted depth never blocks a spawn", () => {
    // The launch path always passes the child's depth explicitly. If a caller
    // forgets, the safe default is "not at the limit" — blocking would break
    // every spawn, which is worse than allowing one extra level.
    assert.equal(resolveDenyTools({ spawning: true }).size, 0);
  });
});
