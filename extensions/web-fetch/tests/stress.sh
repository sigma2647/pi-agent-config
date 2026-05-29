#!/usr/bin/env bash
# Stress / smoke test for pi-wf extractors.
#
# Phase 1 — Coverage: one URL per known path, sequential.
# Phase 2 — Concurrency: fire N pi-wf processes in parallel against mixed URLs.
# Phase 3 — Edge cases: 404, malformed URLs, unreachable hosts.
#
# Exit 0 if all expected-pass cases pass; non-zero otherwise.
#
# Usage:
#   ./tests/stress.sh                # full run
#   ./tests/stress.sh phase1         # just phase 1
#   ./tests/stress.sh phase2         # just phase 2
#   ./tests/stress.sh phase3         # just phase 3
#   PARALLEL=8 ./tests/stress.sh     # tweak phase-2 concurrency (default 5)

set -uo pipefail

BIN="${PI_WF_BIN:-pi-wf}"
TIMEOUT_S="${TIMEOUT_S:-45}"
PARALLEL="${PARALLEL:-5}"
TMPDIR_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# ── colors ───────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
	G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
else
	G=""; R=""; Y=""; C=""; N=""
fi

# ── globals (test counters) ──────────────────────────────────────────
PASS=0
FAIL=0
SKIPPED=0
FAILED_NAMES=()

# ── helpers ──────────────────────────────────────────────────────────

# run_case <name> <url> <expect-pattern|-> <min-bytes|0> <max-seconds>
# expect-pattern of "-" means "no content check" (only timing + exit code).
# min-bytes 0 means "no size check" (used for expected failures).
run_case() {
	local name="$1" url="$2" expect="$3" minbytes="$4" maxsec="$5"
	local out="$TMPDIR_ROOT/$(echo -n "$name" | tr -c '[:alnum:]' '_').out"
	local err="$TMPDIR_ROOT/$(echo -n "$name" | tr -c '[:alnum:]' '_').err"
	local started ended elapsed ec size

	started=$(date +%s.%N)
	timeout "$TIMEOUT_S" "$BIN" "$url" > "$out" 2> "$err"
	ec=$?
	ended=$(date +%s.%N)
	elapsed=$(awk "BEGIN { printf \"%.2f\", $ended - $started }")
	size=$(wc -c < "$out")

	local ok=1 why=""
	if [[ "$expect" == "FAIL" ]]; then
		# expected-fail case: pass if pi-wf returns non-zero
		if [[ $ec -ne 0 ]]; then ok=1; else ok=0; why="expected failure but got success"; fi
	else
		if [[ $ec -ne 0 ]]; then ok=0; why="exit=$ec"; fi
		if [[ $ok -eq 1 && "$minbytes" -gt 0 && $size -lt "$minbytes" ]]; then
			ok=0; why="size=${size}B < minbytes=${minbytes}B"
		fi
		if [[ $ok -eq 1 && "$expect" != "-" ]]; then
			if ! grep -qE "$expect" "$out"; then
				ok=0; why="pattern not found: $expect"
			fi
		fi
		# soft check: too slow → warn but still pass
		if [[ $ok -eq 1 && "$maxsec" -gt 0 ]] \
		   && awk "BEGIN { exit !($elapsed > $maxsec) }"; then
			printf "  %s%s%s slower than %ss (took %ss)\n" "$Y" "WARN" "$N" "$maxsec" "$elapsed"
		fi
	fi

	if [[ $ok -eq 1 ]]; then
		PASS=$((PASS+1))
		printf "  %sPASS%s  %-30s  %5sB  %ss\n" "$G" "$N" "$name" "$size" "$elapsed"
	else
		FAIL=$((FAIL+1))
		FAILED_NAMES+=("$name")
		printf "  %sFAIL%s  %-30s  %5sB  %ss  %s%s%s\n" "$R" "$N" "$name" "$size" "$elapsed" "$Y" "$why" "$N"
		if [[ -s "$err" ]]; then
			head -2 "$err" | sed 's/^/        | /'
		fi
	fi
}

# Phase 1 — coverage: hit every extractor + each major fallback level.
phase1() {
	echo "${C}── Phase 1: coverage ($BIN) ──${N}"
	# bilibili
	run_case "bilibili-video"  "https://www.bilibili.com/video/BV1GJ411x7h7"           "Never Gonna Give You Up" 300 5
	# github (3 sub-paths)
	run_case "github-blob"     "https://github.com/anthropics/claude-code/blob/main/README.md"  "Raw:"            500 10
	run_case "github-issue"    "https://github.com/anthropics/claude-code/issues/1"     "Create SECURITY"       300 10
	run_case "github-repo"     "https://github.com/anthropics/claude-code"              "anthropics/claude-code" 500 10
	# hackernews
	run_case "hackernews-item" "https://news.ycombinator.com/item?id=39000000"          "HN item"               200 10
	# wechat (the SSR-hidden trick)
	run_case "wechat-article"  "https://mp.weixin.qq.com/s/51jRNrnPKnQfYFBr8ISILA"      "SKILL"                3000 6
	# generic Readability path — wikipedia is reliable + heavy text
	run_case "generic-wiki"    "https://en.wikipedia.org/wiki/HTTP"                     "Hypertext Transfer"    2000 8
	# generic Readability — MDN as a backup signal
	run_case "generic-mdn"     "https://developer.mozilla.org/en-US/docs/Web/HTTP"      "HTTP"                  1000 10
	# playwright auto-trigger (zhihu)
	if [[ -d "${HOME}/.pw-capture-profile" ]]; then
		run_case "playwright-zhihu" "https://zhuanlan.zhihu.com/p/2041847079815926006"  "终极价值"           1000 15
	else
		SKIPPED=$((SKIPPED+1))
		printf "  %sSKIP%s  %s (no pw profile)\n" "$Y" "$N" "playwright-zhihu"
	fi
}

# Phase 2 — concurrency: fire $PARALLEL pi-wf processes simultaneously.
# Tests that there are no race conditions in shared state (e.g., zhihu cookie
# cache, gh CLI availability cache, defuddle availability cache).
phase2() {
	echo
	echo "${C}── Phase 2: concurrency ($PARALLEL parallel) ──${N}"
	local urls=(
		"https://www.bilibili.com/video/BV1GJ411x7h7"
		"https://github.com/anthropics/claude-code"
		"https://github.com/anthropics/claude-code/issues/1"
		"https://news.ycombinator.com/item?id=39000000"
		"https://mp.weixin.qq.com/s/51jRNrnPKnQfYFBr8ISILA"
	)
	local started ended elapsed pids=() ok=0 fail=0
	started=$(date +%s.%N)
	# Round-robin enqueue
	for i in $(seq 1 "$PARALLEL"); do
		local url="${urls[$(( (i-1) % ${#urls[@]} ))]}"
		(
			out="$TMPDIR_ROOT/par_${i}.out"
			timeout "$TIMEOUT_S" "$BIN" "$url" > "$out" 2>&1
			echo "$?" > "$TMPDIR_ROOT/par_${i}.ec"
			wc -c < "$out" > "$TMPDIR_ROOT/par_${i}.size"
		) &
		pids+=("$!")
	done
	for p in "${pids[@]}"; do wait "$p"; done
	ended=$(date +%s.%N)
	elapsed=$(awk "BEGIN { printf \"%.2f\", $ended - $started }")

	for i in $(seq 1 "$PARALLEL"); do
		local ec size
		ec=$(<"$TMPDIR_ROOT/par_${i}.ec")
		size=$(<"$TMPDIR_ROOT/par_${i}.size")
		if [[ "$ec" -eq 0 && "$size" -gt 200 ]]; then
			ok=$((ok+1))
			printf "  %sPASS%s  worker-%-2d  %sB\n" "$G" "$N" "$i" "$size"
		else
			fail=$((fail+1))
			printf "  %sFAIL%s  worker-%-2d  exit=%s size=%sB\n" "$R" "$N" "$i" "$ec" "$size"
		fi
	done
	PASS=$((PASS+ok))
	FAIL=$((FAIL+fail))
	echo "  ${C}wall-clock: ${elapsed}s for $PARALLEL parallel jobs${N}"
}

# Phase 3 — edge cases: malformed/404/unreachable.
phase3() {
	echo
	echo "${C}── Phase 3: edge cases ──${N}"
	run_case "404-github-repo"  "https://github.com/this-org-does-not-exist-xyzqq/no-such-repo"  "FAIL" 0 10
	run_case "malformed-url"    "not-a-url"                                                      "FAIL" 0 5
	run_case "404-page"         "https://news.ycombinator.com/item?id=999999999999"              "FAIL" 0 10
	run_case "unreachable-host" "https://nonexistent.invalid.example.test/"                      "FAIL" 0 10
}

# ── main ─────────────────────────────────────────────────────────────

mode="${1:-all}"

if ! command -v "$BIN" >/dev/null 2>&1; then
	echo "error: $BIN not found in PATH" >&2
	exit 1
fi

started_all=$(date +%s.%N)

case "$mode" in
	phase1) phase1 ;;
	phase2) phase2 ;;
	phase3) phase3 ;;
	all)    phase1; phase2; phase3 ;;
	*)      echo "usage: $0 [phase1|phase2|phase3|all]" >&2; exit 2 ;;
esac

ended_all=$(date +%s.%N)
total=$(awk "BEGIN { printf \"%.2f\", $ended_all - $started_all }")

echo
echo "──────────────────────────────────────────────"
printf "  pass=%s%d%s  fail=%s%d%s  skip=%s%d%s  wall=%ss\n" \
	"$G" "$PASS" "$N" "$R" "$FAIL" "$N" "$Y" "$SKIPPED" "$N" "$total"
if [[ $FAIL -gt 0 ]]; then
	printf "  ${R}failed:${N} %s\n" "${FAILED_NAMES[*]}"
	exit 1
fi
