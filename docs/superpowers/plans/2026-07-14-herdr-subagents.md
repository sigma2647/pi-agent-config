# Herdr Subagent Mux Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable asynchronous subagents to run in a Herdr pane.

**Architecture:** Extend the existing single mux adapter, `cmux.ts`, with a `herdr` backend. Reuse the prior project's Herdr CLI contract while preserving all current backend behavior. Keep parser tests in the existing unit test file.

**Tech Stack:** TypeScript, Node built-in test runner, Herdr CLI.

## Global Constraints

- No new dependency.
- Do not alter cmux, tmux, Zellij, or WezTerm behavior.
- Support `PI_SUBAGENT_MUX=herdr`.
- A usable Herdr target requires a parseable `herdr pane current` response.
- Do not attempt Herdr workspace/tab renaming without a verified CLI contract.

---

### Task 1: Add Herdr detection and lifecycle support

**Files:**
- Modify: `extensions/subagents/pi-extension/subagents/cmux.ts`
- Test: `extensions/subagents/test/test.ts`

**Interfaces:**
- Produces: `MuxBackend` includes `"herdr"`.
- Produces: `parseHerdrPaneCurrent(raw: string): { paneId: string; focused: boolean } | null`.
- Produces: `parseHerdrPaneSplit(raw: string): string | null`.

- [ ] **Step 1: Write failing parser tests**

Add to `extensions/subagents/test/test.ts`:

```ts
it("parses Herdr pane responses and split output", () => {
  assert.deepEqual(
    parseHerdrPaneCurrent('{"result":{"pane":{"pane_id":"w1:p9","focused":true}}}'),
    { paneId: "w1:p9", focused: true },
  );
  assert.equal(
    parseHerdrPaneSplit('{"result":{"pane":{"pane_id":"w1:p10"}}}'),
    "w1:p10",
  );
  assert.equal(parseHerdrPaneSplit("created pane w1:p11"), "w1:p11");
});
```

- [ ] **Step 2: Run the parser test to verify it fails**

Run:

```bash
cd extensions/subagents && node --test test/test.ts
```

Expected: FAIL because `parseHerdrPaneCurrent` and `parseHerdrPaneSplit` are not exported.

- [ ] **Step 3: Implement the minimal Herdr branch**

In `cmux.ts`:

```ts
export type MuxBackend = "cmux" | "tmux" | "zellij" | "wezterm" | "herdr";
```

Add parsing and current-pane availability checks. Add `herdr` branches to surface creation, command execution, Escape, screen reading, and closing using the CLI commands in the design document. Return early from workspace/tab rename functions for Herdr.

- [ ] **Step 4: Run the unit suite to verify the implementation**

Run:

```bash
cd extensions/subagents && npm test
```

Expected: PASS with zero failures.

### Task 2: Document the supported backend

**Files:**
- Modify: `extensions/subagents/README.md`

**Interfaces:**
- Consumes: `PI_SUBAGENT_MUX=herdr` from Task 1.
- Produces: README lists Herdr as a supported multiplexer and preference value.

- [ ] **Step 1: Update supported-backend lists and examples**

Add Herdr to both supported-multiplexer lists and change preference examples to:

```bash
export PI_SUBAGENT_MUX=cmux   # or herdr, tmux, zellij, wezterm
```

- [ ] **Step 2: Verify documentation references the backend consistently**

Run:

```bash
cd extensions && rg -n 'PI_SUBAGENT_MUX=.*herdr|\[Herdr\]' subagents/README.md
```

Expected: at least one supported-list hit and one preference-example hit.

### Task 3: Verify the complete change

**Files:**
- Verify: `extensions/subagents/pi-extension/subagents/cmux.ts`
- Verify: `extensions/subagents/test/test.ts`
- Verify: `extensions/subagents/README.md`

- [ ] **Step 1: Run all subagent tests**

Run:

```bash
cd extensions/subagents && npm test
```

Expected: exit status 0 and zero failing tests.

- [ ] **Step 2: Inspect the targeted diff**

Run:

```bash
git diff -- extensions/subagents/pi-extension/subagents/cmux.ts extensions/subagents/test/test.ts extensions/subagents/README.md
```

Expected: only Herdr support, its tests, and documentation changes.
