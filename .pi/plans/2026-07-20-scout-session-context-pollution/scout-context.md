# Context Pollution Investigation: `setup.sh`'s `global/AGENTS.md → ~/.pi/agent/AGENTS.md`

## Task
Verify whether `setup.sh`'s `global/AGENTS.md → ~/.pi/agent/AGENTS.md` symlink causes repository-specific instruction pollution (repo A's AGENTS.md leaking into repo B's sessions).

Investigation completed at `2026-07-20T06:xx:xxZ` (Beijing +8).

## Structure of Report

- **Section 1** — Content analysis: root AGENTS.md vs global/AGENTS.md (EVIDENCE)
- **Section 2** — Current symlink and history (EVIDENCE)
- **Section 3** — Pi 0.80.10 context loading mechanism (EVIDENCE)
- **Section 4** — Session files: evidence of pollution (EVIDENCE)
- **Section 5** — Three-category verdict: retroactive mutation / future resume / current session
- **Section 6** — Timeline (CRITICAL — shows a genuine but temporary pollution window)

---

## Section 1: Root AGENTS.md vs global/AGENTS.md Content

### Root `AGENTS.md` (`/home/lawrence/pi-agent-config/AGENTS.md`, 13.8K)

Contains **repo-specific pi-agent-config instructions**:

- Extension system conventions (every `index.ts` must register both tool and command, kebab-case naming, `.ts` import suffix)
- Fallback chain details (web-fetch: `domain extractor → defuddle → http+Readability → Jina Reader → Playwright`)
- Gotchas for each extension (Defuddle means the library not CLI; Zhihu blocks all server-side fetches; etc.)
- Collaboration patterns (simple mechanism + smart diagnostics; LLM-friendly defaults; explain observed differences)
- Cross-machine debugging (check `pi-wf --doctor`, Node version, env vars before blaming code)
- Exa backend opt-in details, Playwright probe paths, OpenCLI Browser Bridge update procedure
- **Confidence: HIGH** — This is the pi-agent-config project's source-of-truth file, by design. Loading this into other repos would be pollution.

### `global/AGENTS.md` (`/home/lawrence/pi-agent-config/global/AGENTS.md`, 3.5K)

Contains **generic behavioral instructions** applicable to ANY project:

- Language preference (Chinese reasoning/reply)
- Web search tool names (pi-ws, pi-wf, zhihu) — these are user-global tools, not repo-specific
- Output format rules (headings for multi-level content, bullet lists, term annotations)
- Information density rules (no greetings/conclusion, no fluff, conclusion-first)
- Reply attitude rules (don't flatter, balance pros/cons, verify facts)
- Execution discipline (check docs before guessing, ask humans when uncertain, test after changes)
- Single Source of Truth principles (avoid shotgun surgery / divergent change)
- **Confidence: HIGH** — No pi-agent-config-specific content. Safe for cross-repo use.

### APPEND_SYSTEM.md

`/home/lawrence/pi-agent-config/global/APPEND_SYSTEM.md` — **0 bytes** (empty file, no-op in system prompt).

---

## Section 2: Current Symlink and History

### Current State

```
~/.pi/agent/AGENTS.md → /home/lawrence/pi-agent-config/global/AGENTS.md  (mtime Jul 20 13:49)
~/.pi/agent/APPEND_SYSTEM.md → /home/lawrence/pi-agent-config/global/APPEND_SYSTEM.md  (mtime Jul 20 13:49, empty)
```

**Confidence: HIGH** — Currently correct. global/AGENTS.md is generic, safe for cross-repo use.

### History from Git

| Commit | AUTHORS | setup.sh Behavior |
|--------|---------|-------------------|
| `0001539` (original) | original setup | `LINK_FILES` included `"AGENTS.md"` → symlinked `$REPO_DIR/AGENTS.md` (root, 13.8K) |
| `6dad8bf` | "Fix setup polluting repo..." | Still had `"AGENTS.md"` in LINK_FILES |
| `c65248f` (HEAD) | "Add --dry-run..." | Still had `"AGENTS.md"` in LINK_FILES |
| **Uncommitted** | Current state | Removed `AGENTS.md` from LINK_FILES; added explicit `link_one "$REPO_DIR/global/AGENTS.md" "$PI_DIR/AGENTS.md"` |

**Confidence: HIGH** — The fix (using `global/AGENTS.md` instead of root) is **uncommitted**.

### Backup Evidence

`~/.pi/agent/.backup/20260720-134954/` contains only `keybindings.json` (465 bytes, dated Jun 1). No AGENTS.md backup exists — the previous root AGENTS.md symlink was simply replaced by the new `ln -s` (setup.sh detects "symlink pointing elsewhere" and replaces without backup).

---

## Section 3: Pi 0.80.10 Context Loading Mechanism

### Source files examined
- `/home/lawrence/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js`
- `/home/lawrence/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js`
- `/home/lawrence/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`
- `/home/lawrence/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`
- `/home/lawrence/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md`

### Context File Loading (`loadProjectContextFiles`)

1. `loadProjectContextFiles()` scans `~/.pi/agent/` for `AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD` — **GLOBAL context first**.
2. Then walks ancestor directories from CWD to root, adding each directory's first matching file.
3. Deduplicates by resolved path.
4. Returns `contextFiles[]` array.

**Source**: `resource-loader.js:48-73`, `loadContextFileFromDir()` at line 30-46.

### System Prompt Building (`buildSystemPrompt`)

The `contextFiles` are embedded into the LLM system prompt via:
```
<project_context>
Project-specific instructions and guidelines:
<project_instructions path="...">
[file content]
</project_instructions>
</project_context>
```

**Source**: `system-prompt.js:76-83` (for customPrompt path) and lines 127-134 (for default path).

### When is the system prompt rebuilt?

`_rebuildSystemPrompt()` in `agent-session.js` (line 716-745) is called:
1. **Constructor** → `_buildRuntime()` → `_refreshToolRegistry()` → line 649
2. **`/reload`** → `reload()` → `_buildRuntime()` → `_refreshToolRegistry()` → line 1781
3. **Tool changes** → `refreshTools()` → `_refreshToolRegistry()` → line 1781

**Source**: `agent-session.js:649-650`, `agent-session.js:716-745`.

### Session File Storage

Session files (JSONL) store:
- `SessionHeader` (type, version, id, timestamp, cwd)
- `SessionMessageEntry` (role, content, tool calls, usage)
- `ModelChangeEntry`, `ThinkingLevelChangeEntry`
- `CompactionEntry`, `BranchSummaryEntry`
- `CustomEntry`, `CustomMessageEntry`
- `LabelEntry`, `SessionInfoEntry`

**The system prompt is NEVER serialized into session files.** On resume, `buildSessionContext()` produces the message list from stored entries, but the system prompt is a SEPARATE parameter passed to the LLM API call (`agent.state.systemPrompt` at line 650), always rebuilt from current files.

**Source**: `session-format.md` — "Context Building" section, `agent-session.js:269`.

### The `--no-context-files` / `-nc` flag

Pi has a CLI flag `--no-context-files` / `-nc` that **disables AGENTS.md/CLAUDE.md discovery and loading entirely**.

**Source**: `cli/args.js:258`, `resource-loader.js:323`.

### `/reload` behavior

`/reload` in interactive mode (line 4392-4457 of `interactive-mode.js`) calls `session.reload()` which:
1. Reloads `settingsManager`
2. Resets API providers
3. Calls `_resourceLoader.reload()` — re-reads AGENTS.md, SYSTEM.md, extensions, skills, etc.
4. Rebuilds runtime → rebuilds system prompt

**A `/reload` during a session will pick up the CURRENT `~/.pi/agent/AGENTS.md` immediately.**

---

## Section 4: Session Files — Evidence of Pollution

### Search Results

- **Zero session files** contain `project_instructions` or `project_context` strings.
- **Zero session files** contain `AGENTS.md` references.
- **Zero session files** contain `systemPrompt` or `APPEND_SYSTEM` references.

**Confidence: HIGH** — Session files store only conversation messages, never the system prompt with embedded context file content.

### Modification Time Analysis

- Old session files (May-June 2026): mtimes match their original creation times. **No retroactive modification.**
- Session files in the `12:34-13:49` window: show expected incremental writes (new messages appended). Content is normal conversation entries.

---

## Section 5: Three-Category Verdict

### (A) Retroactive Mutation of Old Session Files

**VERDICT: NO — No evidence of retroactive mutation. Confidence: HIGH.**

- Session files are write-once-append-only JSONL. Pi never backfills or rewrites existing entries.
- No `project_instructions`, `project_context`, or AGENTS.md content found in any session file.
- File mtimes match original creation times for pre-existing sessions.
- Session files store only conversation messages, never the system prompt.

### (B) Future Behavior When Resuming an Old Session

**VERDICT: The CURRENT global/AGENTS.md (generic, safe) will be loaded. Confidence: HIGH.**

- On resume, Pi opens the session file and rebuilds the system prompt from scratch.
- `_rebuildSystemPrompt()` reads the CURRENT `~/.pi/agent/AGENTS.md` (now pointing to `global/AGENTS.md`, generic).
- The stored session messages are unchanged — only the system prompt is rebuilt.
- **Exception:** `--no-context-files` disables AGENTS.md loading entirely.

### (C) Current Already-Running Session Behavior

**VERDICT: Current sessions pre-date both symlink changes. Confidence: HIGH.**

- Current `--home-lawrence--` sessions started at `05:03` and `05:53` Beijing time.
- First setup.sh ran at `12:34`, second at `13:49`.
- These sessions loaded whatever was at `~/.pi/agent/AGENTS.md` at `05:xx` — which was before any repo AGENTS.md was symlinked there.

---

## Section 6: Timeline — The Critical Pollution Window

| Time (Beijing +8) | Event | Impact |
|---|---|---|
| ~05:00 | Current Pi sessions start | Loaded whatever ~/.pi/agent/AGENTS.md was at that time |
| **12:34** | **First setup.sh run (HEAD commit)** | **Symlinked ROOT AGENTS.md (13.8K, repo-specific) → ~/.pi/agent/AGENTS.md ← POLLUTION BEGINS** |
| 12:34-13:49 | Active Pi sessions | Any START or RESUME during this window would load repo-specific root AGENTS.md as global context |
| 13:43 | global/AGENTS.md created | Generic behavioral instructions extracted from root AGENTS.md |
| 13:48 | setup.sh modified (uncommitted) | Removed AGENTS.md from LINK_FILES, added explicit global/AGENTS.md symlink |
| **13:49** | **Second setup.sh run (uncommitted)** | **Replaced symlink: global/AGENTS.md (3.5K, generic) → ~/.pi/agent/AGENTS.md ← FIX APPLIED** |
| Now (14:xx) | Current state | Symlink points to global/AGENTS.md. Safe. |

### Sessions Active During Pollution Window

16 session files have mtimes between 12:34 and 13:49, spanning `pi-agent-config` and `browser-probe` directories. These sessions were actively written during the window. Their in-memory system prompts at creation/resume during this window would have included repo-specific root AGENTS.md content. **Session files themselves are clean.**

### Risk Assessment

- **Nature**: Transient runtime pollution only. When those sessions resume later, they will load the current (safe) global/AGENTS.md.
- **Scope**: Any Pi session started or resumed in ANY working directory during 12:34-13:49 would have received repo-specific AGENTS.md as global `project_instructions`.
- **Impact**: Root AGENTS.md contains extension dev conventions, fallback chain internals, and collaboration patterns. Architecturally incorrect as universal instructions, but not harmful.
- **Remediation**: Already applied (13:49). Must commit the uncommitted fix to prevent reoccurrence on other machines.

---

## Gotchas

1. **The fix is uncommitted.** `setup.sh` and `global/AGENTS.md` are untracked/modified in git. `global/` directory needs to be added and committed. HEAD's `LINK_FILES` still has `"AGENTS.md"` which would re-create pollution on fresh checkout. **Must commit before next git pull on other machines.**

2. **SYSTEM.md vs AGENTS.md are separate loading paths.** `discoverSystemPromptFile()` loads `SYSTEM.md`, `loadProjectContextFiles()` loads `AGENTS.md`. Both end up in the LLM system prompt but through different functions (`discoverSystemPromptFile` → `systemPrompt`, `loadContextFileFromDir` → `agentsFiles`).

3. **`global/AGENTS.md` has user-specific rules** (prefer Chinese, use pi-ws/pi-wf, specific formatting rules). These are intended as global agent rules. Cloners should review.

4. **Multi-level loading**: Pi loads AGENTS.md from `~/.pi/agent` AND from each ancestor directory of CWD. Project-level files supplement, not replace, the global one.

5. **Content quoting in messages**: If an assistant quoted AGENTS.md instructions in responses, those quoted snippets would appear in session file messages. This is content pollution (words in conversation), not context pollution (file loaded as instructions). Not found in examined sessions.
