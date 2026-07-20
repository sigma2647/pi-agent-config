# AGENTS.md — pi-agent-config

Source of truth for this repo. Cross-tool (Claude Code via `CLAUDE.md @-import`, Codex, OpenCode, OpenClaw), cross-machine (in git, so `gpd-arch` / `jy-gzz-arch` both see the same content). `CLAUDE.md` is only an entry-point stub; **don't add content there** — extend this file instead.

Personal `pi-agent-config` — extensions for `@earendil-works/pi-coding-agent`.

Every extension serves two consumption paths:

1. **pi loader** — agent runtime loads `index.ts` via `package.json`'s `pi.extensions`. Registers tools, commands, hooks.
2. **CLI** — standalone `dev.ts` runnable as `pi-<name>`. Declared in `package.json`'s `pi.cli`. Symlinked into `~/.local/bin` by `extensions/install.sh`.

Same source files serve both. Don't duplicate logic between `index.ts` and `dev.ts`; share via `chain.ts` / `core.ts`.

## Layout

```
agent/
└── agents/               ← personal Git-managed definitions; ~/.pi/agent/agents symlinks here
extensions/
├── install.sh           ← unified installer (manifest-driven)
├── web-fetch/           ← single-URL fetch + extract → markdown        (pi-wf)
│   ├── core.ts          ← orchestrator + fallback chain
│   ├── storage.ts       ← in-memory truncated-content store for retrieval
│   ├── extractors/      ← one file per site (bilibili/github/HN/reddit/wechat)
│   ├── engines/         ← extraction engines (defuddle/readability/jina/playwright/pdf)
│   └── tests/stress.sh  ← 3-phase smoke test (coverage / concurrency / edge)
├── web-search/          ← multi-backend search                          (pi-ws)
│   ├── chain.ts         ← backend registry + chain dispatcher
│   ├── validate.ts      ← relevance filtering (keyword-match results against query)
│   └── backends/        ← one file per source (brave/exa/opencli/browser)
├── subagents/           ← vendored pi-interactive-subagents package
│   ├── package.json     ← pi entrypoint: ./pi-extension/subagents/index.ts
│   ├── pi-extension/    ← async mux-backed subagent extension implementation
│   ├── agents/          ← bundled definitions (planner/scout/worker/reviewer/etc.)
│   └── test/            ← upstream Node smoke/integration tests
└── _common/             ← shared utilities (playwright resolver, CLI helpers)
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
- **Define each user-facing option once on the shared core (`chain.ts` / `core.ts`).** `index.ts` and `dev.ts` parse native input and pass the same semantic value through without intermediate mode vocabularies or duplicated mappings. Export one shared description constant. If both entry points contain `=== "someMode"`, collapse that mapping into the core.
- **Playwright is an optional peerDep.** Resolved via `extensions/web-fetch/playwright.ts` (probes `playwright` / `playwright-core` plus `/usr/lib/node_modules/...` and `/usr/local/lib/node_modules/...` for distro-managed installs). Activated via `PI_WF_PLAYWRIGHT=1`, `pi-wf --playwright`, or by matching `PLAYWRIGHT_AUTO_HOSTS` in `core.ts` (currently `zhihu|weibo|xiaohongshu`).
- **Stealth init script** in `core.ts` patches `navigator.webdriver` / `userAgentData` / WebGL fingerprint. Inline ~30 lines, not the 180 KB puppeteer-extra-plugin-stealth. Sufficient for most CN sites.

## Fallback chains

**web-fetch** (per URL): `domain extractor → defuddle → http+Readability → Jina Reader → Playwright (gated)`. Defuddle is the default because its metadata, sections, and Pandoc footnotes are more LLM-friendly for ~260ms extra. Opt out with `--no-defuddle` or `PI_WF_PREFER_DEFUDDLE=0`; `--defuddle` remains a no-op alias.

**web-search** (per query): `brave → opencli → browser`, stopping at the first non-empty result by design; do not add fan-out/RRF. Exa is registered but opt-in via `PI_WEB_SEARCH_CHAIN` or `--chain exa`. `fast` queries only the first backend. CLI output defaults to JSON (`--human` / `PI_WS_FORMAT=human` opt out), and unknown flags are errors. `--proxy` overrides Brave only; opencli inherits env and the already-running browser keeps its launch proxy. The backend registry and types are re-exported for third parties.

**`web_search` is general-web only.** Site-scoped search belongs in an opencli adapter plus a concrete `promptGuidelines` pointer, never in the stop-at-first-non-empty backend chain. URL extraction remains a separate `web-fetch` concern.

**subagents** is a vendored async mux package loaded through its own `package.json`; it returns immediately, shows a live widget, and steers results back. Discovery precedence is project `.pi/agents/` → global `~/.pi/agent/agents/` → bundled. Personal definitions live in Git-tracked `agent/agents/` (the global directory symlinks there); package defaults stay in `extensions/subagents/agents/`.

## Gotchas

- **`#!/usr/bin/env -S node ... --experimental-loader=./foo` is cwd-relative**, not script-relative. Don't add loader hooks; use `.ts` suffixes in imports instead.
- **Proxy model:** env vars are the default; `--proxy` / tool `proxy` override per call. `NODE_USE_ENV_PROXY=1` must be set in the shebang before Node starts. `makeContext()` builds one dispatcher reused by every fetch path and Chromium. Bypass with blank proxy env; do not add per-domain routing.
- **`FetchContext` is the fallback chain's single argument carrier.** Add a per-call knob only to its interface and `makeContext()`; downstream extractors keep `(ctx, ...)`. CLI and tool entry points feed the same `FetchOptions` into `fetchAndExtract()`.
- **Keep network errors actionable.** `describeNetworkError()` must include the code and a cause-specific hint for proxy refusal, direct timeout, DNS, or TLS. Skip downstream fallbacks after a shared network failure.
- **Defuddle means the `defuddle/node` library, not its CLI.** Feed it the existing linkedom document; do not restore the slow, proxy-incompatible subprocess path. `--doctor` probes the import.
- **Run `pi-wf --doctor` before debugging fallback availability; use `pi-wf --debug <url>` for timed chain traces.**
- **`html.duckduckgo.com/html/` serves a CAPTCHA challenge now** ("select all squares with a duck"). Browser backend uses Bing; Bing wraps result URLs in `bing.com/ck/a?u=a1<urlsafe-b64>` — decode the `u` param.
- **Zhihu blocks all anonymous server-side fetches** (HTML and API; Jina too). Only working path: `pi-wf --login https://www.zhihu.com` once, then `pi-wf --playwright` reuses cookies in `~/.pw-capture-profile`.
- **`npm i -g playwright` does NOT make `import("playwright")` work.** Node's ESM resolver walks up from the script's `node_modules`; it never checks npm's global prefix or `/usr/lib/node_modules`. Always go through `playwright.ts:loadPlaywright()` which probes the known distro/system paths and uses `createRequire` as a fallback. For Arch users: `sudo pacman -S playwright` installs to `/usr/lib/node_modules/playwright` and is already in the probe list.
- **gh CLI**: `gh auth status --no-refresh` flag was removed; use plain `gh auth status`. Always invoke via `execFile(['gh', ...args])` with argv, never shell strings — URL path segments can contain `;`/`$`/spaces.
- **OpenCLI Browser Bridge 更新必须遵循 `docs/opencli-extension-update.md`。** 下载并验证 zip 后才能删除旧目录；保持扩展路径不变，完成后提醒用户在 `chrome://extensions` 手动刷新。
- **`new Date(ts * 1000).toISOString()` throws on invalid `ts`.** Wrap in `safeDate()` (already in bilibili/zhihu extractors) when handling external API timestamps.
- **Don't read browser profile Cookies SQLite directly.** Use Playwright with `launchPersistentContext` so cookies load natively + transparently.
- **OpenCLI auto-wake** — when the opencli backend detects the daemon running but the Browser Bridge extension disconnected, it auto-launches headed Chromium with `--load-extension=<unpacked-dir>` on port 19826 and polls `opencli daemon status` for up to 10s. Code is inline in `backends/opencli.ts` (wake functions below the exported backend).
- **Web-fetch truncation + retrieval (`storage.ts`)** — pages >30KB are truncated in the tool response and the full content stored in-memory (30-min TTL, pruned on `session_start`). The truncated output includes a `retrieveId` the agent can pass as `web_fetch({ retrieve: "<id>" })` to get the full document without re-fetching. No disk I/O, no session persistence — lives only as long as the pi process.
- **Exa backend (`backends/exa.ts`)** — registered but NOT in the default chain. Requires `EXA_SEARCH_API_KEY`. Semantically-driven search (neural embeddings + keyword fusion), ~2.4x slower than Brave, higher noise rate on technical queries. Use via `--chain exa` or `PI_WEB_SEARCH_CHAIN=brave,exa,...`.

## Environment

- Node ≥ 22.6 (for `--experimental-strip-types`)
- `jq` (for `extensions/install.sh`)
- `gh` (optional — auto-detected by `extractors/github.ts`, improves rate limits)
- `playwright` (optional peerDep — only needed for web-fetch's last-resort fallback)
- `defuddle` (local dep of web-fetch — `npm install` in `extensions/web-fetch/` pulls it; provides the `defuddle/node` library used as an intermediate fallback and as the `--defuddle` primary extractor)

## Testing

`tests/stress.sh [phase1|phase2|phase3|all]` in web-fetch runs coverage / concurrency / edge cases. `npm run test:subagents` runs the subagent helper tests. No other formal test framework — smoke tests via the CLI binaries are the norm.

---

# Collaboration patterns

Apply these before implementation. They are durable decision rules, not a change log.

## 1. Simple mechanism + smart diagnostics

Prefer one predictable default plus sharp diagnostics over domain routing, learned caches, or automatic strategy switching. For proxies, `HTTP_PROXY` / `HTTPS_PROXY` are the source of truth; bypass explicitly with blank env or `unset`. Add cause-aware error hints instead of another routing layer.

## 2. LLM-friendly defaults when the cost is small

When a richer structured result costs less than about 500ms extra, prefer it by default and expose CLI + env opt-outs. Examples: Defuddle over flat Readability output, JSON over human-only search output. State when the agent tool shares the same core and inherits the default automatically.

## 3. Explain observed differences with evidence

For “为什么结果不一样” questions:

1. Measure both sides instead of speculating.
2. Show quantitative deltas in a comparison table.
3. Include the same representative sample from each output.
4. Diagnose the actual version, engine, config, dependency, or environment difference.
5. Propose a fix only after establishing the mechanism.

## 4. Cross-machine differences: check environment before code history

The two Arch hosts (`gpd-arch`, `jy-gzz-arch`) normally share source but can differ in dependencies and network state. Compare, in order: git commit; `pi-wf --doctor`, Node and optional dependency versions; relevant env vars (`HTTP_PROXY`, `PI_WF_PREFER_DEFUDDLE`, `PI_WS_FORMAT`); then code history.

## 5. Test sweeping add/delete advice against actual usage

Before accepting external feature-list or deletion advice, apply three checks:

1. **Agent ≠ user:** measure agent tool demand, not only the user's manual frequency.
2. **Existing working code has low marginal maintenance:** delete only when it blocks requirements, produces wrong output, or removes a costly dependency.
3. **Simple default + explicit override:** prefer one default with a flag/env escape hatch over smart modes and auto-routing.

Push back with project evidence when any check fails; do not manufacture a “balanced” endorsement.

## 6. Site-scoped search is not a general backend

For Bilibili, Zhihu, WeChat, YouTube, arXiv, and similar site search:

1. Check `opencli list | grep -i <site>`.
2. If an adapter exists, add a concrete `promptGuidelines` pointer such as `opencli <site> search "<kw>" -f json`; do not register it in the stop-at-first-non-empty general chain.
3. Treat URL extraction separately: a matching `web-fetch` domain extractor is appropriate because it activates only for its own domain.

Only a genuine general web engine that could answer every query belongs in `web-search/backends/`.
