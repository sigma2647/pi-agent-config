# AGENTS.md — pi-agent-config

Source of truth for this repo. Cross-tool (Claude Code via `CLAUDE.md @-import`, Codex, OpenCode, OpenClaw), cross-machine (in git, so `gpd-arch` / `jy-gzz-arch` both see the same content). `CLAUDE.md` is only an entry-point stub; **don't add content there** — extend this file instead.

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
- **A user-facing option's type + default + meaning lives ONCE on the shared core (`chain.ts` / `core.ts`), and the entry points pass it straight through.** `index.ts` (pi tool param) and `dev.ts` (CLI flag) are two *input surfaces* for the same knob — each parses its native input (TypeBox schema vs argv), but neither may invent an intermediate vocabulary or re-translate input→behaviour. Counter-example we removed (2026-06-10): a search "mode" knob existed as a 2-value enum `instant`/`full` in the tool schema, a `--instant` flag in the CLI, AND a `shortCircuit` boolean in `runChain` — three layers, the enum→boolean mapping (`=== "instant"`) duplicated in both entry points. Renaming it meant editing 3 files / 6 sites (shotgun surgery). Fix: `runChain` takes a single semantic boolean (`fast`) directly; both entry points read their own input and pass `fast` through with zero translation; the human description is one exported const (`FAST_OPTION_DESC`). If you find yourself writing `=== "someMode"` in *both* `index.ts` and `dev.ts`, that's the smell — collapse the vocabulary onto the core.
- **Playwright is an optional peerDep.** Resolved via `extensions/web-fetch/playwright.ts` (probes `playwright` / `playwright-core` plus `/usr/lib/node_modules/...` and `/usr/local/lib/node_modules/...` for distro-managed installs). Activated via `PI_WF_PLAYWRIGHT=1`, `pi-wf --playwright`, or by matching `PLAYWRIGHT_AUTO_HOSTS` in `core.ts` (currently `zhihu|weibo|xiaohongshu`).
- **Stealth init script** in `core.ts` patches `navigator.webdriver` / `userAgentData` / WebGL fingerprint. Inline ~30 lines, not the 180 KB puppeteer-extra-plugin-stealth. Sufficient for most CN sites.

## Fallback chains

**web-fetch** (per URL): `domain extractor → defuddle (lib) → http+Readability → Jina Reader → Playwright (gated)`. **Defuddle is the default primary extractor** as of late May 2026 — cleaner Pandoc footnotes (`[^N]:` + matching `[^N]` inline anchors in body text), schema.org metadata (`> 作者: ... · 发布: ... · 字数: ...`), and more complete section structure (`## 概要 / ## 官方年表` etc. that Readability would discard via low-score pruning). Trade-off vs Readability: ~260ms slower but dramatically friendlier for LLM consumption. Opt out per-call with `pi-wf --no-defuddle <url>` or globally with `PI_WF_PREFER_DEFUDDLE=0`. `--defuddle` is kept as a no-op alias. defuddle is the `defuddle/node` library, NOT the CLI — see Gotchas.

**web-search** (per query): `brave → opencli → browser`, stops at the first non-empty backend — **by design**. The three are a primary (`brave`) + fallbacks (`opencli`/`browser`), not peer-quality engines, so fan-out + RRF merge (which only pays off across genuinely complementary engines, e.g. SearXNG's 70) would add latency + noise for little breadth — **don't add it**; a fan-out attempt was reverted for this reason. Per-call `pi-ws --fast` (tool param `fast: true`) queries only the first backend and fails fast — skips the slow `opencli`/`browser` fallbacks. CLI default output is JSON (matches the `web_search` agent tool's payload — same shape, easy to pipe to `jq`). Opt out per-call with `pi-ws --human` or `--format human`, globally with `PI_WS_FORMAT=human`. Unknown `--flags` are hard errors (used to silently get appended to the query). Per-call `--proxy <url>` plumbs into `Backend.search(query, signal, opts?: SearchOptions)` via `runChain` — honored by `brave` (overrides env-based detection); `opencli` inherits env (subprocess); `browser` (CDP) connects to a pre-launched Chromium whose proxy is fixed and ignores per-call override. Third parties can register backends via `import { registerBackend } from "<this-extension>"` (the registry + `Backend` / `SearchOptions` types are re-exported from `index.ts`).

**`web_search` is general-web only — site-scoped search lives in opencli, not in the chain.** Keyword→list *within a single site* (B站视频/知乎/微博/YouTube/arXiv/BOSS直聘 …) is a different capability than the interchangeable general engines in the `brave → opencli → browser` chain — registering a site-scoped backend there would pollute generic queries (chain stops at first non-empty). opencli already ships these adapters (`opencli list` → e.g. `opencli bilibili search "<kw>" -f json`), and the bilibili **fetch** extractor handles the BV→content half. The agent's discovery gap (it reaches for `web_search` not knowing opencli site-search exists) is closed by a pointer in `web_search`'s `description` + `promptGuidelines` in `web-search/index.ts` — pure text, no routing code, no domain list (points at `opencli list` instead). Do NOT add a bilibili (or any site-scoped) backend to the chain; extend the guideline pointer instead.

## Gotchas

- **`#!/usr/bin/env -S node ... --experimental-loader=./foo` is cwd-relative**, not script-relative. Don't add loader hooks; use `.ts` suffixes in imports instead.
- **Proxy model: env vars are the default; per-call override via `--proxy <url>` or the `proxy` tool param.** The shebang's `NODE_USE_ENV_PROXY=1` makes Node 24's built-in `fetch` honor `HTTP_PROXY` / `HTTPS_PROXY` env vars (it ignores them by default — running `fetch` without the flag is the most common cause of `TypeError: fetch failed`). When `opts.proxy` is set, `makeContext()` builds a `ProxyAgent` once and threads it via the dispatcher in `FetchContext` — every fetch helper, every extractor, and Chromium (`launchPersistentContext({ proxy: { server } })`) pick it up from the same source. **Every outbound request goes through that single dispatcher**; if it dies, all fetches fail (including CN sites). Escape hatches: `HTTPS_PROXY= HTTP_PROXY= pi-wf <url>` (single call) or `unset HTTP_PROXY HTTPS_PROXY` (whole shell). Don't add smart per-domain routing — the cure is worse than the disease.
- **`FetchContext` is the single argument carrier for the fallback chain.** Every extractor signature is `(ctx: FetchContext, ...)` — adding a new per-call knob (timeout, userAgent, custom headers, ...) means editing **two** spots: the `FetchContext` interface and the `makeContext()` builder. No downstream signatures change. `dev.ts` parses CLI flags, `index.ts` translates agent tool params, and both feed `FetchOptions` into `fetchAndExtract()` which builds the ctx. The dispatcher is pre-built once per call and reused across all 5 fetch sites (extractViaHttp / extractWithDefuddle / extractWithJinaReader / extractWithPlaywright / domain extractors) plus the `fetchJson`/`fetchText` helpers in `extractors/types.ts`.
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

---

# Collaboration patterns

Patterns established with this user across prior conversations. Apply BEFORE diving into code — these protect against repeating earlier mistakes and against being swayed by external advice that looks reasonable in the abstract.

## 1. Simple mechanism + smart diagnostics > smart auto-routing

Prefer a dumb, predictable core mechanism plus diagnostic intelligence on top, rather than auto-routing / auto-learning / domain heuristics.

**Why:** During the 2026-05 proxy thread, an auto-learning per-domain proxy cache (route blocked-in-CN sites through proxy, others direct, learn from failures) was proposed and explicitly rejected — "算了太复杂了使用最简单的". The chosen model: honor `HTTP_PROXY` / `HTTPS_PROXY` env vars as the single source of truth, escape via blank env or `unset`. **Separately**, cause-aware error hints were added on top (`ECONNREFUSED` w/ proxy → "Clash dead? bypass with HTTPS_PROXY="; `ETIMEDOUT` w/o proxy → "may be blocked, try HTTPS_PROXY=…"). The pattern: a dumb global default + sharp error messages beats one auto-routing system that tries to be smart.

**How to apply:** When tempted to add a domain list, learned cache, per-host policy, auto-retry-with-fallback-strategy, or otherwise "smart" routing layer — first present the dumber alternative (single env var / single flag / single global default) AND offer to add diagnostics to the bare mechanism instead. Diagnostics are cheap, deliver the same UX win, and don't add a moving part. See also §2 for the related "simple default + opt-out" pattern.

## 2. LLM-friendly defaults over raw speed (when delta < 500ms)

When picking defaults for extraction / parsing / output formatting, **default to the LLM-friendlier output** even at a small speed cost (~hundreds of ms). Always expose env-var + CLI opt-out so the dumber/faster path remains accessible.

**Why:** Defuddle library (~1.7s, Pandoc `[^N]:` footnotes + schema.org metadata + complete section structure) vs Readability+Turndown (~1.4s, flat numbered backref list, sections pruned) trade-off was measured side-by-side. Four options were presented; the user chose "能接受速度 默认使用更友好的 结构对llm更好的" → make defuddle the default, keep `--no-defuddle` and `PI_WF_PREFER_DEFUDDLE=0` as escape hatches. Same call earlier on `pi-ws`: JSON default + `--human` / `PI_WS_FORMAT=human` opt-out.

**How to apply:** When picking a default and the two options are "fast + flat" vs "slower + structurally richer (footnotes, metadata, sections, machine-readable shape)" and the speed delta is < ~500ms — pick the structured one as default, always expose an opt-out (env var + CLI flag), and explicitly mention "agent tool path picks this up automatically because it shares the same code" so the user knows LLM consumption benefits without extra work. See §1 for the dual rule: keep the default simple, expose opt-out via env+flag, not auto-detection.

## 3. Diff-style "why" questions → comparison tables, not hand-wavy answers

When the user observes a difference ("why is jy-gzz-arch's output cleaner than gpd-arch's" / "why does commit 6f77c90 also work" / "为什么结果不一样") — respond with **diagnostic explanation + structured side-by-side comparison (markdown table is ideal)**, not just a fix.

**Why:** The user asks "为什么" frequently and validates that pattern: when responses include concrete metric tables (耗时 / 行数 / Pandoc 脚注定义数 / 内联引用数 / 绝对 URL 数 / 章节标题数) plus same-paragraph rendering comparisons, they engage with the analysis and make informed decisions. When the analysis is skipped to jump to the fix, they push back. They want to understand the mechanism before accepting the change.

**How to apply:** When diff-style questions come up:
1. Run the actual comparison (don't speculate — measure both sides)
2. Lay out metrics in a markdown table with quantitative deltas
3. Sample the same paragraph from both outputs to show what the user actually sees
4. Diagnose root cause (different engine, different config, different version, different env)
5. Only after the diagnosis is in place: propose the fix and ask for confirmation

Counter-example: hand-wavy "they're different because the algorithms differ" without numbers gets pushed back. The user values mechanism transparency — see §1.

## 4. Two Arch test boxes: cross-machine diffs are usually env/dep, not code

The user runs `pi-wf` / `pi-ws` on at least two Arch Linux boxes:
- `gpd-arch` — primary dev box (where Claude Code typically runs)
- `jy-gzz-arch` — separate box, may have different installed deps / Node version / network conditions

**Why:** When comparing outputs across machines (e.g. "jy-gzz-arch's wiki output is cleaner — why?"), the root cause is almost always **per-machine environment differences** (defuddle installed on one but not the other; different `linkedom` / `@mozilla/readability` versions; different GeoIP affecting which HTML the server returns; etc.) — NOT the source code, which is identical via git.

**How to apply:** When the user reports "this machine works, that one doesn't" or "old version on machine X looked different":
1. First confirm the **code commit** is the same on both (often is — same git repo)
2. Compare **installed deps**: `which defuddle`, `npm list playwright`, `node -v`, `pi-wf --doctor` on each box
3. Compare **env vars**: `HTTP_PROXY`, `PI_WF_PREFER_DEFUDDLE`, `PI_WS_FORMAT`
4. Only after those rule out env differences, look at code history

Don't assume "old commit also worked" without testing — the code on disk and the network conditions of that machine matter more than the commit hash. See §3 for the diagnostic pattern.

## 5. External "cut/add feature" advice: apply 3-criterion check before agreeing

When user shows external analyses recommending sweeping feature additions OR sweeping feature deletions for pi-agent-config, **don't agree with either**. Both directions are systematically wrong for this project's actual usage profile. Apply this 3-criterion check before endorsing any recommendation.

**Why:** On 2026-05-29 → 2026-05-30 two opposite-direction analyses surfaced back-to-back. The first compared against 4 competitor tools and said "you have only 3 backends, add 11 more like oh-my-pi". The second said "delete everything you don't personally use weekly (Defuddle, Playwright, opencli, domain extractors, PDF, wiki cleanup)". Both contained factual errors against documented code state (e.g. claiming Defuddle adds 260ms with no quality improvement — disproved by measured 17 vs 0 Pandoc footnotes; claiming Playwright is redundant with Jina — contradicted by the Zhihu gotcha above showing Jina also fails; claiming domain extractors are redundant — they extract structured PR comments / Reddit threads / HN nested replies that Readability cannot reach). Both were rejected.

**How to apply:** Before endorsing a "cut X" or "add Y" recommendation, walk these three checks:

1. **"Agent ≠ user" check.** Frequency from the user's perspective does NOT predict value for Claude. The user reads Wikipedia 3x/year; Claude reads Wikipedia 3x/day. "You never read PDFs" is irrelevant — Claude reads papers/RFCs constantly during code tasks. Reject any "you never use X" argument unless the metric is Claude's actual tool call rate, not the user's manual usage.

2. **"Completed code has ~0 marginal maintenance" check.** Code that's written, tested, and not actively blocking new requirements costs nothing to keep. The "delete 1200 lines down to 800" framing assumes deletion is free — it isn't (test regression risk, broken edge cases, loss of optionality). Only cut code that is (a) blocking a new requirement, (b) producing wrong output, or (c) carrying a heavy external dep you'd remove anyway. "I'd never use this" alone is not sufficient.

3. **"Simple default + per-call override" check.** When new features are proposed (smart per-domain routing, auto-learned proxy cache, reranking, mode tiers, etc.), check whether the same UX could be reached with a dumb default + an env var or CLI flag. See §1 — this pattern has already been chosen explicitly (proxy model, JSON-default for pi-ws, Defuddle-default for pi-wf all use it). Smart auto-everything systems violate this; per-call overrides honor it.

If a recommendation passes all three, it's worth considering. If it fails any, push back with the specific failure mode rather than soft-rejecting.

**Anti-pattern to avoid:** Producing a "balanced" summary that half-validates both extreme analyses to seem neutral. The user wants honest pushback with specific counter-evidence (cite the relevant section above, the relevant measurement, the relevant prior decision), not feature-checklist mediation. See §3.
