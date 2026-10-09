# Browser automation policy

Single source of truth for how web and browser work is routed in this setup. The
always-on files keep only a pointer here. If you are about to add a routing rule
anywhere else, add it here instead.

## Entry points and boundaries (five routes)

| Route | Use it for | Notes |
|---|---|---|
| `web_fetch` | a known URL, static content, docs, articles | fastest path; no browser launch, no profile state |
| `web_search` | general discovery when there is no URL yet | owned by the local `extensions/web-search` (`brave → browser-probe`); the npm `pi-web-access` package that used to occupy this name is no longer loaded |
| site CLI (bash) | site-scoped structured search | e.g. `zhihu search <query>` / `zhihu global <query>`. Do not add site adapters to the `web_search` fallback chain. |
| **Browser Probe** (native `browser_probe`) | rendered, authenticated, or interactive pages; live session state | the strategic default whenever a matching skill/tool path exists |
| native `agent_browser` / direct CDP | compatibility fallback and low-level integration debugging | see the quick contract below |

Two boundaries that are easy to get wrong:

- `web_fetch` vs `browser-probe read`: use `web_fetch` when the page is public and
  needs no login and no JS. Reach for `browser-probe read` when the body only
  appears after JS, sits behind a login, or the static path hit a bot wall.
- After `web_search` returns URLs: hand a URL to the browser only when its body
  needs login, JS, or the static fetch failed; otherwise `web_fetch` it.

## Fallback chains (three real ones)

**1. web-fetch** (`extensions/web-fetch/core.ts`) — domain extractor → Defuddle
(default primary) → Readability (single `undici` HTTP) → Jina → Browser Probe →
Playwright. One branch descends to the browser early: a local-egress `fetch
failed` (`core.ts:206`) skips Jina and tries the browser directly. The other
browser call (`core.ts:237`) is the chain's normal Browser Probe slot, reached
only after Jina returns null. Opt out of Defuddle with `--no-defuddle` or
`PI_WF_PREFER_DEFUDDLE=0`. Domain extractors (5): bilibili, github, hackernews,
reddit, wechat (`mp.weixin.qq.com/s/`). There is no zhihu extractor — zhihu goes
through the bash `zhihu` CLI.

**2. web-search** (`extensions/web-search/chain.ts`) — `brave → browser-probe`, stopping at
the first *strong* result set. 0 matches counts as empty and the chain continues;
a non-empty but weak set escalates to the next backend instead of stopping. Weak
= fewer than `MIN_STRONG_RESULTS` (3) results, or no result carrying more than
the `MIN_TOKEN_HITS` (2) bar `validate.ts` already uses. Escalation only: the
weak set is discarded, never merged with the next backend's, so this is still
not fan-out and still not RRF. A weak set is kept only as a last resort: if no
entry in the chain produces a strong set (the fallback is unavailable, say), the
chain returns the latest weak set it saw instead of failing, so a thin answer is
never traded for a failed chain. The gate exists
because of a measured miss: a Chinese query stopped on a thin Brave set and the
fallback — the browser-probe half — never ran (`/tmp/web-token-bench/REPORT.md`,
test 1). Exa is registered but opt-in only; it is not in the default chain.

**3. browser-probe `search`** — a bare `search` walks Google → Bing.
`--engine <name>` runs one engine alone and never falls back; `--chain a,b,c`
replaces the order and is an instruction, not a hint. A list that is nearly all
one host is marked `low` and the chain moves on. This is the sanctioned exception
to "don't drive search-engine forms": `browser-probe search` deliberately does
exactly that. Do not re-add a blanket ban on it.

## Bot-wall failure semantics

- browser-probe 0.10.0 throws `BlockedError` (`src/l4-automation/extract/dispatch.ts:73`) for
  `read` and `weixin` when the page is a bot/CAPTCHA wall. The `kind: "blocked"`
  field was added 2026-10-06; before that the extract returned all-null fields
  silently and read as "the article is empty". That detection is a code fact and
  has not changed; whether a given page *is* a wall is conditional — see the
  WeChat re-test below.
- WeChat: a browser hit on `mp.weixin.qq.com/s?...` *can* 302-redirect to
  `/mp/wappoc_appmsgcaptcha?poc_token=...`; that redirect is a wall, not a
  result. It is not a permanent property of the host. Re-tests on 2026-10-09 (see
  `/tmp/web-token-bench/REPORT.md`, tests 1–2) got the article body on 9/9 cold
  and warm samples, and the only wall that day sat one layer up, on the
  `weixin.sogou.com/antispider/` jump page (curl hit it, the browser passed). One
  caveat: those samples came back as temporary sogou share links (`src=11&signature=...`)
  instead of canonical `__biz=` links, so the mp.weixin wall may be link-shape
  specific and the re-test may have missed it. Keep the detection either way — it
  is cheap, and it checks the landed `location.href`.
- Do not attempt CAPTCHA bypass.
- Stop before order / post / purchase / submit unless the user explicitly
  authorizes that final action.

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

## Optional change list

Format: problem → change → cost → recommendation.

1. **A bot-wall page is returned as a normal result (WeChat `wappoc_appmsgcaptcha`)** →
   detect the CAPTCHA landing (302 target, or a body with no `#js_content`) and
   raise `BlockedError` the same way `read`/`weixin` already do → **done**
   (`src/extract/weixin-blocked.ts` checks the landed `window.location.href` for
   `wappoc_appmsgcaptcha` and the body for `环境异常` without `#js_content`; `read`
   and `weixin` both raise via `dispatch.ts` → `assertNotBlocked`. Covered by
   `tests/extract/weixin-blocked.test.ts`, incl. the false-positive cases. The
   302 landing was already inside that check — it is `location.href`, not the
   requested URL).

2. **Browser Probe reads as the bottom of the chain, so it only ever sees the hard
   cases (survivorship bias)** → log the winning entry per task: add a
   `winner: <backend>` line where `extensions/web-search/chain.ts` stops early
   (and reuse web-fetch `core.ts`'s existing `→ returning: <engine>` logs) →
   needs a measurement pass before any routing change → **measured 2026-10-09
   (`/tmp/web-token-bench/REPORT.md`)**. The pass exists now, and it did not
   produce a case for promoting Browser Probe wholesale: it is the strategic
   *browser* path, not the cheap reader (its `read` output is 1.9× the bytes /
   2.75× the characters of `web_fetch` on the same pages, worst case 24.3× on
   Xiaohongshu), and the one routing miss it did surface was on the search side —
   which item 3 below fixes. The `winner:` log line is still not added: the chain
   attempt list already carries the winning `backend` plus each entry's `kind`,
   which is what the measurement needed.

3. **Brave returns a non-empty but low-quality list** → add a
   `lowQuality(results)` predicate in `extensions/web-search/chain.ts` (reuse
   browser-probe `search`'s "nearly all one host" rule) and continue to the next
   backend when it fires → quality heuristics over-trigger easily → **done
   2026-10-09** as the strength gate (`validate.ts:isStrongResultSet`, called from
   `chain.ts`): result count below `MIN_STRONG_RESULTS` (3), or no single result
   carrying more than `MIN_TOKEN_HITS` (2) query tokens, means "weak → escalate".
   The predicate is a count + token bar rather than the host-concentration rule:
   host concentration did not show up in the measurements, a thin set did, and
   the token bar is built on the constant `isRelevant` already uses instead of a
   second copy. Costs one extra backend call when it over-triggers, bounded by the
   per-backend budgets; leaves `fast` and `--chain` untouched. Covered by
   `extensions/web-search/test/chain-gate.test.ts` (weak escalates, strong stops,
   a weak set is kept when nothing stronger arrives, empty still escalates).

4. **How to turn Exa on, and when it is worth it** → document the switch: Exa is
   registered in `extensions/web-search/chain.ts` but kept out of `DEFAULT_CHAIN`;
   enable it with `--chain exa,brave` (or `--chain exa`) → extra API cost →
   **pending** (list the long-tail / semantic cases that justify it).

5. **The `agent_browser` migration policy is missing** — the old root
   `AGENTS.md` pointed at a `docs/browser-automation.md` section that does not
   exist → write a short section: what stays on native `agent_browser`, what
   migrates to Browser Probe, and the exit condition → needs a decision on whether
   `agent_browser` is still in use → **do it** (at minimum record "keep, no
   migration planned").

6. **`web_fetch` vs `browser-probe read`, and when `web_search` results go to the
   browser** → turn the two boundary heuristics above into an explicit
   condition → route table under the boundaries section: default `web_fetch`;
   escalate to `browser-probe read` only when the fetch error names JS/login, the
   rendered body is empty, or the page needs the logged-in profile → low cost,
   but more rules risk more drift → **partly done** (interim rule written above;
   add the table only if the rule keeps being wrong).
