# Subagents Workflow Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the optional orchestrator skill and bundled planning workflow accurately match the tools and resources available in this repository.

**Architecture:** Keep the subagents runtime and its neutral tool-driven orchestration unchanged. Correct the optional skill's factual contract, then replace the bundled planner/worker workflow's unavailable `todo` tool and `commit` skill dependencies with task sections stored directly in `plan.md`.

**Tech Stack:** Markdown agent definitions and skills, TypeScript `node:test` regression test, npm.

## Global Constraints

- Work directly in `/home/lawrence/pi-agent-config`; do not create or use a git worktree.
- Do not modify `extensions/subagents/pi-extension/subagents/index.ts` or add always-on orchestration guidance.
- Do not add dependencies, tools, skills, automatic routers, or concurrency limits.
- Do not modify or remove `extensions/subagents/agents/visual-tester.md`; its adaptation is a separate decision.
- Preserve the current `subagent` fire-and-forget, steer delivery, agent discovery, and session-mode behavior.
- Workers execute sequentially because they share one checkout.
- Stage and commit only the files listed by the current task; leave unrelated and pre-existing untracked files untouched.

---

### Task 1: Correct the optional orchestrator skill contract

**Files:**
- Modify: `skills/orchestrator/SKILL.md`

**Interfaces:**
- Consumes: bundled agent frontmatter in `extensions/subagents/agents/{scout,researcher,worker,planner}.md` and the `subagent` tool contract.
- Produces: an accurate, on-demand top-level orchestration reference; no runtime behavior changes.

- [ ] **Step 1: Record the existing failing reference checks**

Run:

```bash
rg -n 'safe_bash|ask_user_question|maxConcurrency|worker may itself spawn|subagents inherit NO context|Anything needing back-and-forth' skills/orchestrator/SKILL.md
```

Expected before editing: matches for all six stale claims. This is the recorded RED baseline for the reference skill.

- [ ] **Step 2: Correct the role summary**

Replace the claim that exactly three agents exist with wording that these are the skill's primary autonomous specialists. Use these exact capabilities:

```markdown
The primary autonomous specialists used by this skill are dispatched via the
`subagent` tool:

- **scout** — codebase reconnaissance. Tools: `read`, `bash`. Returns a structured map.
- **researcher** — web research. Tools: `web_search`, `web_fetch`. Returns a sourced brief.
- **worker** — isolated code changes. Tools: `read`, `bash`, `write`, `edit`. It cannot spawn subagents.
```

Do not add planner/reviewer routing policy; `/plan` remains the dedicated full planning workflow.

- [ ] **Step 3: Replace the nonexistent clarification tool**

Replace the `ask_user_question` bullet with:

```markdown
- **Ask the user directly** — for ambiguous requirements, choices between approaches, or any detail that would change the implementation. End the response after the question and wait for the reply.
```

- [ ] **Step 4: Correct concurrency, interaction, and context statements**

Apply these rules:

```markdown
- Multiple `subagent` calls emitted in the same turn run concurrently. Keep fan-out bounded to the independent work actually needed; the extension does not impose a default `maxConcurrency` cap.
- Do not give user-preference or back-and-forth decisions to autonomous agents. Ask the user directly; use the interactive planner only when a planning session is intended.
- Standalone subagents do not inherit the parent conversation. Unless `fork: true` is explicitly used, every task must include the needed paths, constraints, and output format.
```

Keep the existing guidance against polling and raw mux lifecycle commands.

- [ ] **Step 5: Verify the corrected skill**

Run:

```bash
! rg -n 'safe_bash|ask_user_question|worker may itself spawn|subagents inherit NO context|capped at `maxConcurrency`' skills/orchestrator/SKILL.md
rg -n 'Tools: `read`, `bash`|It cannot spawn subagents|Ask the user directly|Standalone subagents|does not impose a default' skills/orchestrator/SKILL.md
git diff --check -- skills/orchestrator/SKILL.md
```

Expected: the negative search returns no matches, all five corrected concepts are found, and `git diff --check` exits 0.

- [ ] **Step 6: Commit only the skill change**

```bash
git add skills/orchestrator/SKILL.md
git commit -m "fix: align orchestrator skill with subagent contract"
```

---

### Task 2: Make the bundled plan workflow self-contained

**Files:**
- Modify: `extensions/subagents/test/test.ts`
- Modify: `extensions/subagents/agents/planner.md`
- Modify: `extensions/subagents/agents/worker.md`
- Modify: `extensions/subagents/pi-extension/subagents/plan-skill.md`
- Modify: `extensions/subagents/README.md`

**Interfaces:**
- Consumes: `.pi/plans/YYYY-MM-DD-<name>/plan.md` as the single planning and task artifact.
- Produces: planner-authored `## Implementation Tasks` sections and worker execution driven by explicit task text/path rather than external todo state.

- [ ] **Step 1: Add a failing regression test for optional workflow dependencies**

In `extensions/subagents/test/test.ts`, add a `describe("bundled workflow prompts", ...)` block that reads:

```ts
const workflowPromptPaths = [
  new URL("../agents/planner.md", import.meta.url),
  new URL("../agents/worker.md", import.meta.url),
  new URL("../pi-extension/subagents/plan-skill.md", import.meta.url),
];
```

For every file, assert that its content does not match any of:

```ts
/\btodo\s*\(/
/\/skill:commit\b/
/\bwrite-todos\b/
```

Test name:

```ts
it("does not require optional todo or commit resources", () => { ... })
```

Run:

```bash
cd extensions/subagents && npm test
```

Expected before prompt edits: FAIL because planner, worker, and plan-skill still reference those resources.

- [ ] **Step 2: Convert planner output from todos to plan tasks**

In `extensions/subagents/agents/planner.md`:

- Change frontmatter description and opening text from “plan + todos” to “plan with implementation tasks”.
- Rename Phase 9 from `Create Todos` to `Write Implementation Tasks`.
- Remove the `write-todos` skill instruction and `todo({ action: "create", ... })` example.
- Require the planner to append `## Implementation Tasks` to the same `plan.md` artifact.
- Each task section must use this shape:

```markdown
### Task N: <title>

- **Files:** exact files to create or modify
- **References:** an inline code example or an existing `path:line-range` pattern
- **Constraints:** libraries/patterns to use and anti-patterns to avoid
- **Acceptance:** commands or observable criteria proving completion
```

- Keep tasks independently executable and sequenced.
- Change the final summary to report the number of task sections, not todo IDs.
- Replace remaining “todos” wording throughout the file with “implementation tasks” where it refers to the removed external tool.

- [ ] **Step 3: Make worker consume explicit tasks without todo/commit resources**

In `extensions/subagents/agents/worker.md`:

- Change frontmatter description to `Implements well-scoped tasks - writes code, runs tests, and reports verified results`.
- Keep the tool whitelist unchanged: `read, bash, write, edit`.
- Replace the todo-centric workflow with exactly five stages:
  1. Read the task and referenced plan/context.
  2. Verify it includes expected outcome, files or references, constraints, and acceptance criteria; if essential context is missing, call `caller_ping` with the specific missing information and stop.
  3. Implement the smallest scoped change.
  4. Run the acceptance checks and relevant regression tests.
  5. Report changed files, commands/results, and concerns.
- Remove all `todo(...)`, todo claim/release/close instructions, and `/skill:commit` instructions.
- Do not add `todo`, `subagent`, web tools, or commit tooling to the whitelist.

- [ ] **Step 4: Make `/plan` execute task sections from `plan.md`**

In `extensions/subagents/pi-extension/subagents/plan-skill.md`:

- Replace “todos” with “implementation tasks in `plan.md`”.
- Tell the planner task to save both the design and `## Implementation Tasks` to the plan path.
- In Phase 4, read and review that section directly; remove `todo({ action: "list" })`.
- In Phase 5, spawn sequential workers with prompts shaped as:

```ts
subagent({
  name: "🔨 Worker 1/N",
  agent: "worker",
  task: "Implement Task 1 from [plan path]. Read the task section and follow its files, references, constraints, and acceptance criteria.\n\nScout context: [summary]",
});
```

- For reviewer P0/P1 findings, write explicit corrective worker tasks rather than creating todos.
- Completion checklist must require all plan tasks completed and verified; remove the commit-skill requirement.

- [ ] **Step 5: Synchronize README with the actual bundle**

In `extensions/subagents/README.md`:

- Update bundled model labels to the current definitions:
  - planner/reviewer: `DeepSeek V4 Pro` with their documented thinking level;
  - scout/researcher/worker/visual-tester: `DeepSeek V4 Flash` with worker minimal thinking where useful.
- Describe planner as writing plans with implementation tasks.
- Describe worker as implementing well-scoped tasks and reporting verified results.
- Change `/plan` workflow wording from todos to plan tasks.
- Remove `todo` from the tools-widget example; use a generic available-tool ellipsis instead.
- Do not rewrite unrelated README sections.

- [ ] **Step 6: Run the focused and full verification**

Run:

```bash
cd extensions/subagents && npm test
rg -n 'todo\s*\(|/skill:commit|write-todos' agents/planner.md agents/worker.md pi-extension/subagents/plan-skill.md
rg -n -i 'creates todos|from todos|implement todos|confirm todos|commit skill|polished commit' README.md agents/planner.md agents/worker.md pi-extension/subagents/plan-skill.md
git diff --check
```

Expected: `npm test` passes all tests; both searches return no matches; `git diff --check` exits 0.

- [ ] **Step 7: Commit only the bundled workflow files**

```bash
git add extensions/subagents/test/test.ts \
  extensions/subagents/agents/planner.md \
  extensions/subagents/agents/worker.md \
  extensions/subagents/pi-extension/subagents/plan-skill.md \
  extensions/subagents/README.md
git commit -m "fix(subagents): remove unavailable workflow dependencies"
```

---

## Final Verification

After both task reviews are clean, run from the repository root:

```bash
npm --prefix extensions/subagents test
git diff --check
git status --short
```

Then perform a whole-change review against:

- `docs/adr/subagents-orchestrator.md`
- the Global Constraints above
- the actual agent frontmatter and registered tool contract

The final review must confirm that no always-on orchestration, new dependency, router, worktree, or visual-tester change was introduced.
