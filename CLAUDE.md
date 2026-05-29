# CLAUDE.md

Personal `pi-agent-config` — extensions for `@earendil-works/pi-coding-agent`.

Every extension serves two consumption paths:

1. **pi loader** — agent runtime loads `index.ts` via `package.json`'s `pi.extensions`. Registers tools, commands, hooks.
2. **CLI** — standalone `dev.ts` runnable as `pi-<name>`. Declared in `package.json`'s `pi.cli`. Symlinked into `~/.local/bin` by `extensions/install.sh`.

Same source files serve both. Don't duplicate logic between `index.ts` and `dev.ts`; share via `chain.ts` / `core.ts`.

## Layout

```
extensions/
├── install.sh           ← unified installer (manifest-driven)
├── web-fetch/           ← single-URL fetch + extract → markdown        (pi-wf)
│   ├── core.ts          ← orchestrator + fallback chain
│   ├── extractors/      ← one file per site (bilibili/github/HN/reddit/wechat)
│   └── tests/stress.sh  ← 3-phase smoke test (coverage / concurrency / edge)
├── web-search/          ← multi-backend search                          (pi-ws)
│   ├── chain.ts         ← backend registry + chain dispatcher
│   └── backends/        ← one file per source (brave/opencli/browser)
└── subagents/           ← subagent definitions
```

## CLI install workflow

```bash
extensions/install.sh              # install everything in pi.cli
extensions/install.sh --list       # preview
extensions/install.sh --uninstall  # only removes symlinks pointing back into this repo
```

Adding a new CLI = add `pi.cli` to its `package.json`, rerun installer. No per-extension `install.sh`.

```jsonc
"pi": {
  "extensions": ["./index.ts"],
  "cli": [{ "name": "pi-foo", "entry": "./dev.ts" }]
}
```

## Conventions

- **Every relative import ends in `.ts`.** Both pi loader and Node `--experimental-strip-types` accept it. Ext-less works under pi but breaks standalone CLI execution.
- **Every executable `dev.ts` (and any standalone `tools/*.ts`) shebang MUST be `#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings`.** Node 22+ ignores `HTTP_PROXY` / `HTTPS_PROXY` for the built-in `fetch` unless `NODE_USE_ENV_PROXY=1` is set at startup (runtime assignment is too late — `undici` reads it once during init). `env -S` accepts inline `VAR=value` assignments before the interpreter, so this fits in one line. No-op when no proxy env is present.
- **Every extension's `index.ts` MUST register both `pi.registerTool(...)` AND `pi.registerCommand(...)`** unless the extension is intentionally agent-only. Tool = callable by the agent (e.g. `web_fetch`). Command = user-facing slash command (e.g. `/web-fetch`). Forgetting the command means the feature works for the agent but is invisible in the `/`-autocomplete menu. Use kebab-case for the command name to match the extension directory.
- **Domain extractors / backends are pluggable.** New site → new file in `extractors/` or `backends/`, register once in `index.ts`. Don't touch the dispatcher.
- **Playwright is an optional peerDep.** Resolved via `extensions/web-fetch/playwright.ts` (probes `playwright` / `playwright-core` plus `/usr/lib/node_modules/...` and `/usr/local/lib/node_modules/...` for distro-managed installs). Activated via `PI_WF_PLAYWRIGHT=1`, `pi-wf --playwright`, or by matching `PLAYWRIGHT_AUTO_HOSTS` in `core.ts` (currently `zhihu|weibo|xiaohongshu`).
- **Stealth init script** in `core.ts` patches `navigator.webdriver` / `userAgentData` / WebGL fingerprint. Inline ~30 lines, not the 180 KB puppeteer-extra-plugin-stealth. Sufficient for most CN sites.

## Fallback chains

**web-fetch** (per URL): `domain extractor → defuddle (lib) → http+Readability → Jina Reader → Playwright (gated)`. **Defuddle is the default primary extractor** as of late May 2026 — cleaner Pandoc footnotes (`[^N]:` + matching `[^N]` inline anchors in body text), schema.org metadata (`> 作者: ... · 发布: ... · 字数: ...`), and more complete section structure (`## 概要 / ## 官方年表` etc. that Readability would discard via low-score pruning). Trade-off vs Readability: ~260ms slower but dramatically friendlier for LLM consumption. Opt out per-call with `pi-wf --no-defuddle <url>` or globally with `PI_WF_PREFER_DEFUDDLE=0`. `--defuddle` is kept as a no-op alias. defuddle is the `defuddle/node` library, NOT the CLI — see Gotchas.

**web-search** (per query): currently `brave → opencli → browser` (stops at first non-empty). RRF fan-out + merge is a known better design — not yet implemented. CLI default output is JSON (matches the `web_search` agent tool's payload — same shape, easy to pipe to `jq`). Opt out per-call with `pi-ws --human` or `--format human`, globally with `PI_WS_FORMAT=human`. Unknown `--flags` are now hard errors (used to silently get appended to the query — e.g. `pi-ws hello --format json` searched `hello --format json` instead of accepting the flag).

## Gotchas

- **`#!/usr/bin/env -S node ... --experimental-loader=./foo` is cwd-relative**, not script-relative. Don't add loader hooks; use `.ts` suffixes in imports instead.
- **Proxy model is dumb-and-explicit: `HTTP_PROXY` / `HTTPS_PROXY` env vars are the single source of truth.** The shebang's `NODE_USE_ENV_PROXY=1` makes Node 24's built-in `fetch` actually honor those env vars (it ignores them by default — running `fetch` without the flag is the most common cause of `TypeError: fetch failed`). Consequence: **every** outbound request is routed through the proxy. If `127.0.0.1:7890` dies, all fetches fail (including CN sites). Escape hatches: `HTTPS_PROXY= HTTP_PROXY= pi-wf <url>` (single call) or `unset HTTP_PROXY HTTPS_PROXY` (whole shell). Don't add smart per-domain routing — the cure is worse than the disease; just let env vars rule.
- **Network error messages are diagnostic and actionable**, formatted by `describeNetworkError()` in `web-fetch/core.ts`. Each `fetch failed` carries `(CODE)` plus a one-line hint: `ECONNREFUSED` with proxy set → "is Clash/V2Ray running? bypass with `HTTPS_PROXY=` ..."; `ETIMEDOUT` without proxy → "may be blocked, try `HTTPS_PROXY=`..."; `ENOTFOUND` → "DNS lookup failed for ..."; `CERT_*` → TLS issue. When the error starts with `fetch failed`, downstream fallbacks (defuddle / Jina / Playwright) are skipped because they'd hit the same network wall; the diagnostic surfaces directly without the misleading "may be JS-rendered or login-gated" suffix.
- **Defuddle is the `defuddle/node` library, not the CLI.** We `import { Defuddle } from "defuddle/node"` and feed it the linkedom Document we already have — ~400ms per page vs the old subprocess path's ~4s (Node startup + tmpfile + JSON marshaling dominated). Don't go back to `execFile("defuddle", ...)` — apart from being slow, the CLI's own URL fetcher doesn't honor `NODE_USE_ENV_PROXY` so it can't reach anything behind the GFW. `--doctor` probes the library import, not `which defuddle`.
- **`pi-wf --doctor` exists for triage** (see `tools/doctor.ts`). Reports Node version, optional deps (playwright lib / defuddle lib / gh / jq), proxy env state, TCP probe of the proxy port, Playwright profile dir + entry count. Run it first when "why doesn't fallback X kick in?" — the report tells you whether the dep is installed before you chase code. `pi-wf --debug <url>` traces the fallback chain on stderr with per-step timings.
- **`html.duckduckgo.com/html/` serves a CAPTCHA challenge now** ("select all squares with a duck"). Browser backend uses Bing; Bing wraps result URLs in `bing.com/ck/a?u=a1<urlsafe-b64>` — decode the `u` param.
- **Zhihu blocks all anonymous server-side fetches** (HTML and API; Jina too). Only working path: `pi-wf --login https://www.zhihu.com` once, then `pi-wf --playwright` reuses cookies in `~/.pw-capture-profile`.
- **`npm i -g playwright` does NOT make `import("playwright")` work.** Node's ESM resolver walks up from the script's `node_modules`; it never checks npm's global prefix or `/usr/lib/node_modules`. Always go through `playwright.ts:loadPlaywright()` which probes the known distro/system paths and uses `createRequire` as a fallback. For Arch users: `sudo pacman -S playwright` installs to `/usr/lib/node_modules/playwright` and is already in the probe list.
- **gh CLI**: `gh auth status --no-refresh` flag was removed; use plain `gh auth status`. Always invoke via `execFile(['gh', ...args])` with argv, never shell strings — URL path segments can contain `;`/`$`/spaces.
- **`new Date(ts * 1000).toISOString()` throws on invalid `ts`.** Wrap in `safeDate()` (already in bilibili/zhihu extractors) when handling external API timestamps.
- **Don't read browser profile Cookies SQLite directly.** Use Playwright with `launchPersistentContext` so cookies load natively + transparently.

## Environment

- Node ≥ 22.6 (for `--experimental-strip-types`)
- `jq` (for `extensions/install.sh`)
- `gh` (optional — auto-detected by `extractors/github.ts`, improves rate limits)
- `playwright` (optional peerDep — only needed for web-fetch's last-resort fallback)
- `defuddle` (local dep of web-fetch — `npm install` in `extensions/web-fetch/` pulls it; provides the `defuddle/node` library used as an intermediate fallback and as the `--defuddle` primary extractor)

## Testing

`tests/stress.sh [phase1|phase2|phase3|all]` in web-fetch runs coverage / concurrency / edge cases. No formal test framework — smoke tests via the CLI binaries are the norm.
