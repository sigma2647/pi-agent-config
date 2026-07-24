# AGENTS.md — pi-agent-config

Source of truth for this repo. `CLAUDE.md` is only an entry-point stub; **do not add content there**. Detailed repo handbook: `docs/pi-agent-config-handbook.md`.

Personal extensions for `@earendil-works/pi-coding-agent`.

## Always-on rules

- Same source serves pi loader and CLI. Do not duplicate logic between `index.ts` and `dev.ts`; share via `chain.ts` / `core.ts`.
- Relative imports in executable TS files end in `.ts`.
- Executable `dev.ts` / standalone `tools/*.ts` shebang: `#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings`.
- Extension `index.ts` registers both `pi.registerTool(...)` and `pi.registerCommand(...)` unless intentionally agent-only.
- Define user-facing options once on the shared core; `index.ts` and `dev.ts` pass the same semantic values through.
- Domain extractors/backends are pluggable: new site → new file, one registration, dispatcher unchanged.
- Keep network errors actionable and cause-aware.
- For implementation details, gotchas, install workflow, env, and tests, read `docs/pi-agent-config-handbook.md` targeted sections.

## Web and browser routing

- Known URL → `web_fetch`.
- General discovery → `web_search`, then `web_fetch` relevant results.
- Site-scoped structured search → `opencli <site> ... -f json`; do not add site adapters to the general `web_search` fallback chain.
- Rendered/authenticated/interactive browser work → prefer **Browser Probe** when a matching skill/tool path exists; native `agent_browser` is the fallback/compatibility path.
- Native browser details and migration policy: `docs/browser-automation.md`.
- OpenCLI Browser Bridge updates: `docs/opencli-extension-update.md`.

## Current architecture map

```text
agent/agents/                 personal Git-managed agent definitions
extensions/install.sh          unified CLI installer
extensions/web-fetch/          single URL fetch/extract (pi-wf)
extensions/web-search/         brave → opencli → browser search (pi-ws)
extensions/subagents/          async mux-backed subagent package
extensions/_common/            shared utilities
```

## Fallback chains

- **web-fetch:** domain extractor → Defuddle → Readability → Jina → Browser Probe → Playwright. Defuddle default; opt out with `--no-defuddle` or `PI_WF_PREFER_DEFUDDLE=0`.
- **web-search:** `brave → opencli → browser`, stop at first non-empty result. Exa is opt-in only.
- **subagents:** async fire-and-return; results arrive automatically. Bundled specialists use `system-prompt: replace` + `context-files: project`.

## Collaboration patterns

- Prefer one predictable default plus sharp diagnostics over smart routing or hidden caches.
- Compare observed behavior before explaining differences; show quantitative deltas.
- Cross-machine differences: check git commit, doctor output, versions, and env before blaming code history.
- Do not accept broad delete/add advice without checking actual agent demand and maintenance cost.
- Existing working code has low marginal maintenance; delete only when it blocks requirements or causes wrong output.
