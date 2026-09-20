# pi-agent-config handbook

Detailed repo guidance moved out of always-on `AGENTS.md` for progressive disclosure. `AGENTS.md` remains the prompt-facing source of truth and links here when details are needed. `CLAUDE.md` is only an entry-point stub; **don't add content there**.

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
├── dictation/          ← offline + cloud speech-to-text dictation      (pi-dictation)
│   ├── index.ts         ← pi entry: hotkey, /dictation command, transcribe_audio tool
│   ├── dev.ts           ← pi-dictation CLI (record / transcribe / model / doctor)
│   ├── core.ts          ← shared pipeline + doctor report for both entries
│   ├── config.ts        ← ~/.pi/agent/dictation.json (single source of defaults)
│   ├── audio.ts         ← mic capture (ffmpeg/pw-record/arecord/sox) + SIGINT finalize
│   ├── wav.ts           ← PCM helpers: peak, duration, live levels
│   ├── providers/       ← BACKENDS registry (typed by config type) + one file per vendor protocol
│   ├── local/           ← catalog + families/ (one file per model family) + download/delete + sherpa-onnx
│   ├── strings.ts       ← every user-visible word, zh + en
│   ├── keyprobe.ts      ← decode terminal key events (release support), for keytest
│   └── ui.ts            ← border label, level meter, key interception (helpers injected)
├── web-fetch/           ← single-URL fetch + extract → markdown        (pi-wf)
│   ├── core.ts          ← orchestrator + fallback chain
│   ├── storage.ts       ← in-memory truncated-content store for retrieval
│   ├── extractors/      ← one file per site (bilibili/github/HN/reddit/wechat)
│   ├── engines/         ← extraction engines (defuddle/readability/jina/playwright/pdf)
│   └── tests/stress.sh  ← 3-phase smoke test (coverage / concurrency / edge)
├── web-search/          ← multi-backend search                          (pi-ws)
│   ├── chain.ts         ← backend registry + chain dispatcher
│   ├── validate.ts      ← relevance filtering (keyword-match results against query)
│   └── backends/        ← one file per source (brave/exa/browser-probe/opencli)
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

**web-search** (per query): `brave → browser-probe → opencli`, stopping at the first non-empty result by design; do not add fan-out/RRF. Exa is registered but opt-in via `PI_WEB_SEARCH_CHAIN` or `--chain exa`. `fast` queries only the first backend. CLI output defaults to JSON (`--human` / `PI_WS_FORMAT=human` opt out), and unknown flags are errors. `--proxy` overrides Brave only; opencli inherits env and the already-running browser keeps its launch proxy. The backend registry and types are re-exported for third parties.

**`web_search` is general-web only.** Site-scoped search belongs in an opencli adapter plus a concrete `promptGuidelines` pointer, never in the stop-at-first-non-empty backend chain. URL extraction remains a separate `web-fetch` concern.

**dictation** speaks both local and cloud: `providers: { local | openai | groq | siliconflow | glm | deepgram }` with `provider: "auto"` picking the first *ready* entry in that documented order (`local → openai → groq → siliconflow → glm → deepgram`). "Ready" means the model files exist on disk **and** the `sherpa-onnx` package resolves (local), or the key env var resolves (cloud) — no network probing. `local/sherpa.ts` owns that check (`sherpaRuntimeAvailable()`, a path resolve that never loads the WASM) and the `SHERPA_INSTALL_HINT` fix line, so `doctor`, `/dictation status` and the loader error all name the same command instead of claiming "ready" and failing only after the user has spoken. Every backend — the local runtime and every cloud service — is a typed entry in `providers/index.ts:BACKENDS` keyed by config `type`: adding a service is a new file plus one line, and an unregistered config type is a compile error. When nothing is ready, both entry points append `core.ts:notReadyHint()` to the toast, so the hotkey error names the real cause (a missing runtime, a missing key) instead of repeating the two generic suggestions. The offline path is sherpa-onnx WASM (models under `~/.pi/agent/dictation-models/`, downloaded with curl + system tar), so it needs no key and works with no network. UI surface: right-aligned state label inside the prompt border, live level meter above the editor, red/yellow border tint while recording/transcribing.

**The local catalog has two model kinds, and the kind decides the whole flow.** `local/catalog.ts` tags each entry `offline` (SenseVoice, FireRedASR2-CTC: decode the finished WAV) or `streaming` (X-ASR zipformer transducer: decode while the user speaks). Catalog data (which files) is split from family code (how those files become a recognizer): each sherpa-onnx family lives in `local/families/` and registers once in `LOCAL_FAMILIES`, and an unregistered family id is a compile error. A streaming model is chosen by making it `providers.local.model` — there is no separate switch. Then the extension starts the recorder first, buffering the first chunks until the model is loaded (the recognizer is warmed at `session_start`, so the buffer is normally empty), drives `step()` from the existing 120 ms UI ticker — about 10 ms of decode per tick — and writes the partial transcript into the prompt (replacing the live span each tick so ASR revisions do not stack). `/dictation test` still uses a second widget line via `renderLiveText` (`keepTail` measures real terminal columns with `ui.visibleWidth`, so wide CJK characters cannot wrap the layout). Finishing is instant and does not re-run the offline model. `transcribe_audio` and `pi-dictation transcribe` replay a file through the same session. Two traps are already handled: no endpointing (`enableEndpoint: 0`) so a pause mid-dictation cannot restart the stream and drop earlier words, and 1 s of silence appended before `inputFinished()`, without which the last word is missing (measured: 0.3 s is not enough for Chinese). `/dictation provider` and `/dictation model use` write back `dictation.json`; the CLI's `pi-dictation model use <id>` does the same. Both entry points render the model list from `core.ts:localModelRows()`, so the "which is in use / not downloaded" truth and the switch instructions live in one place — the list's last line names the caller's own commands (`/dictation model use <id>` inside pi, `pi-dictation model use <id>` in a terminal).

**Capture writes raw PCM to stdout, not a WAV file.** ffmpeg keeps a `.wav` output at 0 bytes for the whole recording (it patches RIFF sizes at the end), so a file-based meter and timer show nothing until the recording stops. The extension owns the container: every backend streams `s16le` on stdout, the recorder appends to a temp WAV, keeps a 64 KB ring buffer for live levels, derives elapsed time from the captured byte count, and patches the header on stop. An optional `onPcm` listener sees the same chunks (used by streaming dictation; a throwing listener never kills the recording). Same code path for ffmpeg / pw-record / arecord / sox. **Digital silence is the failure users actually hit** (wireless mic with its transmitter off, suspended monitor source), so the silent-recording error and `pi-dictation doctor`/`mic` name the default PulseAudio source, sample 400 ms, and list the alternative inputs instead of only saying "silent".

**Key handling is hold-first with gap detection, and no app shortcut is registered.** `keybindMode: "hold"` (default) records while the hotkey is held and stops when the key comes up; `"toggle"` is press-to-start / press-to-stop, switched at runtime with `/dictation mode` or `pi-dictation mode`. A terminal that reports key releases (the Kitty keyboard protocol with the report-event-types flag) hands hold its stop event directly: pi-tui asks for flags=7 on startup, so ghostty/kitty/wezterm do report releases. tmux swallows them (it never asks the outer terminal for event types and has no kitty-protocol support, absent through tmux 3.8); herdr forwards them (its client pushes flags=7 and re-encodes input per pane). Everywhere else, release is inferred from the auto-repeat stream: the first press opens an 800 ms window — it must outlast the terminal's repeat delay (~500 ms, 660 ms on stock X11) — and every repeat re-arms a 300 ms window; a quiet gap means the key went up. So hold works in every terminal, with no fallback or mode switch; the trade-off is that in toggle mode a second press less than ~0.8 s after the first is read as a repeat and ignored. `pi-dictation keytest` shows what a terminal actually sends and explains which path hold will take. `pi.registerShortcut` is deliberately NOT used for ctrl+r: it makes pi print an "Extension shortcut conflict" note on every start (ctrl+r is also `app.session.rename`). The key is consumed earlier instead, in `ctx.ui.onTerminalInput`, which also beats the built-in binding; the wrapping editor component is the fallback path when that API is absent. Auto-repeat events never act as presses — they only keep the gap timer armed, so holding the key cannot stop the recording. The wrapper must forward host duck-typed members (`onCtrlD`, `onEscape`, `onPasteImage`, `actionHandlers`, `onExtensionShortcut`) — pi copies its default-editor handlers onto a custom editor only when those exist, so dropping them breaks Ctrl+D, Escape and every other extension's shortcut. `ui.ts` has no runtime pi imports — the host injects `EditorHelpers` (`setEditorHelpers` is the test seam), which keeps the pure render helpers testable under plain Node.

**subagents** is a vendored async mux package loaded through its own `package.json`; it returns immediately, shows a live widget, and steers results back. Discovery precedence is project `.pi/agents/` → global `~/.pi/agent/agents/` → bundled. Personal definitions live in Git-tracked `agent/agents/` (the global directory symlinks there); package defaults stay in `extensions/subagents/agents/`.

**Local patch — auto layout (`cmux.ts`, diverges from upstream 3.7.2):** upstream splits every subagent pane off the parent pi pane (`herdr pane split` / `tmux split-window -h`), so a 16-way fan-out halves the parent until panes are 1 column wide. pi dies in a 1-column pane as soon as a double-width glyph (emoji) is rendered: regular TUI mode throws `Rendered line N exceeds terminal width`, fullscreen mode recurses forever in `wordWrapLine`. `createSurface` now reads the live layout (`herdr pane list` plus one `pane layout` per tab holding one of our panes; a single `tmux list-panes -a`), picks the **largest pane this process created (the caller included)**, and splits its longer axis at the golden ratio with the new pane clamped to `MIN_SUBAGENT_PANE_WIDTH` × `MIN_SUBAGENT_PANE_HEIGHT` (40 × 14). When no owned pane can take a split it opens a full-width `herdr tab create` / `tmux new-window`. Panes the user arranged for other work are never split, and a pane is closed only after its own subagent finishes. Measured: eight subagents tile one 158 × 46 tab (98/60, 58/40, then down into 28/14 rows) before a new tab is needed; the caller's own pane shrinks as part of that tiling. Keep this patch when re-vendoring the package.

**Subagent model pool:** subagents prefer a prioritized model list — `~/.pi/agent/subagent-models.json` (`{"models": [ref | {ref, note}], "cooldownMs": n}`), legacy `subagent-models.txt`, or `PI_SUBAGENT_MODEL_POOL` env — instead of inheriting the parent session's model. A run killed by a provider error (429/overload) auto-relaunches on the next pool entry; failed models go into cooldown (`PI_SUBAGENT_MODEL_COOLDOWN_MS` or JSON `cooldownMs`, default 10 min). Single source: env > JSON > txt, no other locations; malformed JSON throws at spawn instead of silently disabling the pool. In this repo the JSON lives at `extensions/subagents/subagent-models.json` and `~/.pi/agent/subagent-models.json` symlinks to it (same pattern as `agents/`, `AGENTS.md`, `keybindings.json`). Tests: `extensions/subagents/test/model-pool.test.ts`.

### context-files frontmatter

- `context-files: all|project|none` defaults to `all`; `project` disables automatic loading and injects only Git-root→child-cwd context files; `none` injects none. Bundled specialists and lilyth use `project` + `system-prompt: replace`; claude-code intentionally does not.
- `standalone`/`lineage-only` copy no parent prompt or conversation; `fork` copies conversation only. Every child rebuilds its system prompt. `replace` removes Pi's default prompt, not discovered skills or tool schemas.

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
- **Committed `package-lock.json` files must resolve to `registry.npmjs.org`.** npm 12 defaults to `allow-remote=none` and refuses any tarball whose host differs from the configured registry, so a lockfile pinned to a personal mirror (`registry.npmmirror.com`, `mirrors.cloud.tencent.com`) fails on every other machine with `EALLOWREMOTE` — and `--replace-registry-host=always` only swaps the host, keeping the mirror's `/npm/...` path and turning the failure into a 404. Normalise with `sed -i 's#https://<mirror-host>/#https://registry.npmjs.org/#g' package-lock.json` (verified with `npm ci` in a scratch copy).
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
