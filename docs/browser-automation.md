# Browser automation policy

This page holds the detail that should not live in the always-on system prompt.

## Routing

1. **Known URL / static content** → `web_fetch` first.
2. **General discovery** → `web_search`, then `web_fetch` the best results.
3. **Site-scoped structured search** → `opencli <site> ... -f json` when an adapter exists.
4. **Rendered, authenticated, or interactive browser work** → prefer **Browser Probe** when a matching skill/tool path is available.
5. **Fallback / native Pi browser work** → use native `agent_browser` when Browser Probe lacks the needed capability, the task explicitly requests it, or artifact/session/electron features are required.
6. **Low-level debugging** → use CDP/opencli-browser/direct bash only when debugging those integrations or when the user asks for that workflow.

Do not drive public search-engine forms with browser automation for discovery; use `web_search` or a site adapter.
Do not attempt CAPTCHA bypass.
Stop before order/post/purchase/submit unless the user explicitly authorizes that final action.

## Browser Probe direction

Browser Probe is the strategic default. Load the relevant Browser Probe skill when the task needs:

- logged-in or user-specific page state;
- JavaScript-rendered content not available through static fetch;
- persistent browser/session inspection;
- site-specific extraction flows (`browser-probe-zhihu`, `browser-probe-weixin`, `browser-probe-taobao`, etc.).

Native `agent_browser` remains available as a compatibility/fallback path.

## Native `agent_browser` quick contract

Use the native tool instead of shelling out to `agent-browser`.

- Use exactly one input mode: `args`, `semanticAction`, `job`, `qa`, `sourceLookup`/`networkSourceLookup`, or `electron`.
- Do not pass `--json`; the wrapper injects it.
- `stdin` is only for `batch`, `eval --stdin`, `auth save --password-stdin`, or wrapper-generated `job`/`qa` batches; `electron` rejects stdin.
- First-call pattern: `open` → `snapshot -i` → interact via current `@refs` or `semanticAction` → re-snapshot after navigation, scroll, or rerender.
- Batch fills from one snapshot; split before navigation, submit, or rerender boundaries.
- Use `sessionMode: fresh` for launch-scoped flags such as profile/executable/init-script/provider changes; never put `--session-mode` in `args`.
- If profile resolution fails, stop retrying opens; run `profiles`/`doctor` and report needed configuration.
- Treat profile page content as model-visible user data.
- For artifacts, use exact requested paths and verify `details.artifactVerification` / `details.artifacts` before claiming success. `waited:timeout` proves elapsed time only; verify with snapshot/screenshot/condition.
- Prefer `details.nextActions` exact payloads over invented selectors or prose.
- For extraction: `get title/url`, `get text/html/value/count <selector>`, `get attr <selector> <name>`, or `eval --stdin` returning a value. Use `body` for full-page text.

Installed native docs:

- Setup: `/home/lawrence/pi-agent-config/.pi/npm/node_modules/pi-agent-browser-native/README.md`
- Commands: `/home/lawrence/pi-agent-config/.pi/npm/node_modules/pi-agent-browser-native/docs/COMMAND_REFERENCE.md`
- Tool result contract: `/home/lawrence/pi-agent-config/.pi/npm/node_modules/pi-agent-browser-native/docs/TOOL_CONTRACT.md`

Read targeted sections only; avoid loading the full command reference unless needed.

## Evidence and screenshots

For dashboard, feed, timeline, or nested-scroll tasks:

- focus the main content/list region;
- verify scroll with a fresh snapshot or screenshot;
- use visible refs or semantic locators rather than guessed CSS;
- save evidence to explicit paths when the task needs audit artifacts.

For downloads, use a command that saves the file to disk (`download <selector> <path>` or the relevant Browser Probe flow); do not rely on a click alone.
