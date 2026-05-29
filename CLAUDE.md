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
- **Domain extractors / backends are pluggable.** New site → new file in `extractors/` or `backends/`, register once in `index.ts`. Don't touch the dispatcher.
- **Playwright is an optional peerDep.** Activated via `PI_WF_PLAYWRIGHT=1`, `pi-wf --playwright`, or by matching `PLAYWRIGHT_AUTO_HOSTS` in `core.ts` (currently `zhihu|weibo|xiaohongshu`).
- **Stealth init script** in `core.ts` patches `navigator.webdriver` / `userAgentData` / WebGL fingerprint. Inline ~30 lines, not the 180 KB puppeteer-extra-plugin-stealth. Sufficient for most CN sites.

## Fallback chains

**web-fetch** (per URL): `domain extractor → http+Readability → defuddle CLI → Jina Reader → Playwright (gated)`

**web-search** (per query): currently `brave → opencli → browser` (stops at first non-empty). RRF fan-out + merge is a known better design — not yet implemented.

## Gotchas

- **`#!/usr/bin/env -S node ... --experimental-loader=./foo` is cwd-relative**, not script-relative. Don't add loader hooks; use `.ts` suffixes in imports instead.
- **Node `fetch` + external `undici` are different module instances.** A `ProxyAgent` from `import("undici")` can't be passed to native `fetch` (`UND_ERR_INVALID_ARG`). Either use the same undici's `fetch`, or set `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=...` and let built-in undici handle proxies.
- **`html.duckduckgo.com/html/` serves a CAPTCHA challenge now** ("select all squares with a duck"). Browser backend uses Bing; Bing wraps result URLs in `bing.com/ck/a?u=a1<urlsafe-b64>` — decode the `u` param.
- **Zhihu blocks all anonymous server-side fetches** (HTML and API; Jina too). Only working path: `pi-wf --login https://www.zhihu.com` once, then `pi-wf --playwright` reuses cookies in `~/.pw-capture-profile`.
- **gh CLI**: `gh auth status --no-refresh` flag was removed; use plain `gh auth status`. Always invoke via `execFile(['gh', ...args])` with argv, never shell strings — URL path segments can contain `;`/`$`/spaces.
- **`new Date(ts * 1000).toISOString()` throws on invalid `ts`.** Wrap in `safeDate()` (already in bilibili/zhihu extractors) when handling external API timestamps.
- **Don't read browser profile Cookies SQLite directly.** Use Playwright with `launchPersistentContext` so cookies load natively + transparently.

## Environment

- Node ≥ 22.6 (for `--experimental-strip-types`)
- `jq` (for `extensions/install.sh`)
- `gh` (optional — auto-detected by `extractors/github.ts`, improves rate limits)
- `playwright` (optional peerDep — only needed for web-fetch's last-resort fallback)
- `defuddle` (optional CLI — `npm i -g defuddle`; used as web-fetch's intermediate fallback)

## Testing

`tests/stress.sh [phase1|phase2|phase3|all]` in web-fetch runs coverage / concurrency / edge cases. No formal test framework — smoke tests via the CLI binaries are the norm.
