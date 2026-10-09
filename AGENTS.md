# AGENTS.md — pi-agent-config

Source of truth for this repo. `CLAUDE.md` is only an entry-point stub; **do not add content there**. Detailed repo handbook: `docs/pi-agent-config-handbook.md`.

Personal extensions for `@earendil-works/pi-coding-agent`.

## Always-on rules

- Same source serves pi loader and CLI. Do not duplicate logic between `index.ts` and `dev.ts`; share via `chain.ts` / `core.ts`.
- Relative imports in executable TS files end in `.ts`.
- Committed `package-lock.json` files resolve to `registry.npmjs.org`; never commit a personal registry mirror host (npm 12 blocks it — see handbook Gotchas).
- Executable `dev.ts` / standalone `tools/*.ts` shebang: `#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings`.
- Extension `index.ts` registers both `pi.registerTool(...)` and `pi.registerCommand(...)` unless intentionally agent-only.
- Define user-facing options once on the shared core; `index.ts` and `dev.ts` pass the same semantic values through.
- Domain extractors/backends are pluggable: new site → new file, one registration, dispatcher unchanged.
- Keep network errors actionable and cause-aware.
- For implementation details, gotchas, install workflow, env, and tests, read `docs/pi-agent-config-handbook.md` targeted sections.

## Web and browser routing

- Four entry points (known URL → `web_fetch`; discovery → `web_search`; site-scoped search → the site CLI; rendered/authenticated/interactive → Browser Probe) plus a compatibility fallback (native `agent_browser` / direct CDP); their boundaries, the three fallback chains, and bot-wall semantics all live in `docs/browser-automation.md` — the single source of truth. Read it before adding a routing rule; do not restate it here.
- Fallback in one line: every fetch chain descends to Browser Probe before Playwright; `web_search` stops at the first *strong* result set (weak = fewer than 3 results, or no result carrying more than 2 query tokens), otherwise it escalates to the next chain entry and keeps the last weak set if nothing stronger arrives; Browser Probe `search` walks Google → Bing.

## Current architecture map

```text
agent/agents/                 personal Git-managed agent definitions
extensions/install.sh          unified CLI installer
extensions/web-fetch/          single URL fetch/extract (pi-wf)
extensions/web-search/         brave → browser-probe search (pi-ws)
extensions/subagents/          async mux-backed subagent package
extensions/dictation/          offline + cloud speech-to-text dictation (pi-dictation)
extensions/prompt-history/     ctrl+r reverse search over prompt history, floating panel
extensions/auto-title/         Chinese session title from the conversation, pushed to the herdr tab
extensions/inline-slash/      complete templates & skills, expand them anywhere in a sentence
extensions/_common/            shared utilities
```

## Fallback chains

- **subagents:** async fire-and-return; results arrive automatically. Bundled specialists use `system-prompt: replace` + `context-files: project`.

## Collaboration patterns

- Prefer one predictable default plus sharp diagnostics over smart routing or hidden caches.
- Compare observed behavior before explaining differences; show quantitative deltas.
- Cross-machine differences: check git commit, doctor output, versions, and env before blaming code history.
- Do not accept broad delete/add advice without checking actual agent demand and maintenance cost.
- Existing working code has low marginal maintenance; delete only when it blocks requirements or causes wrong output.
