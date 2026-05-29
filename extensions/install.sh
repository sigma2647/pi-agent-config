#!/usr/bin/env bash
# Unified installer for all pi extension CLIs.
#
# Each extension declares its CLI binaries in its own package.json:
#
#   "pi": {
#     "cli": [
#       { "name": "pi-wf", "entry": "./dev.ts" }
#     ]
#   }
#
# This installer scans every */package.json, reads .pi.cli, and creates one
# symlink per entry in $BIN_DIR (default ~/.local/bin). One source of truth,
# no per-extension install.sh.
#
# Usage:
#   ./install.sh                # install all declared CLIs
#   ./install.sh --list         # show what would be installed
#   ./install.sh --uninstall    # remove all symlinks this script ever made
#   BIN_DIR=/custom ./install.sh
#
# Adding a new extension's CLI: drop a `pi.cli` array into its package.json
# and rerun. That's it.

set -euo pipefail

EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

if [[ -t 1 ]]; then
	G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
else
	G=""; R=""; Y=""; C=""; N=""
fi

require_jq() {
	if ! command -v jq >/dev/null 2>&1; then
		echo "${R}error:${N} jq is required (sudo apt install jq / brew install jq)" >&2
		exit 1
	fi
}

# Emit one `<name>\t<entry-abs-path>\t<ext-name>` line per declared CLI by
# walking every */package.json. Handles both shapes:
#   "cli": { "name": "foo", "entry": "./bar.ts" }
#   "cli": [ { "name": "foo", "entry": "./bar.ts" }, ... ]
list_entries() {
	require_jq
	local pkg ext_dir ext_name
	for pkg in "$EXT_DIR"/*/package.json; do
		[[ -f "$pkg" ]] || continue
		ext_dir="$(dirname "$pkg")"
		ext_name="$(basename "$ext_dir")"
		jq -r '
			(.pi.cli // empty)
			| if type == "array" then .[] else . end
			| [.name, .entry] | @tsv
		' "$pkg" 2>/dev/null | while IFS=$'\t' read -r name entry; do
			[[ -n "$name" && -n "$entry" ]] || continue
			# Resolve entry relative to the extension dir.
			local abs="$ext_dir/$entry"
			printf '%s\t%s\t%s\n' "$name" "$abs" "$ext_name"
		done
	done
}

cmd_list() {
	local rows
	rows="$(list_entries)"
	if [[ -z "$rows" ]]; then
		echo "no extensions declare a pi.cli — nothing to install"
		return 0
	fi
	printf "%-18s %-22s %s\n" "name" "extension" "entry"
	printf "%-18s %-22s %s\n" "----" "---------" "-----"
	while IFS=$'\t' read -r name abs ext; do
		[[ -n "$name" ]] || continue
		printf "%-18s %-22s %s\n" "$name" "$ext" "$abs"
	done <<< "$rows"
}

cmd_install() {
	local rows count=0 missing=()
	rows="$(list_entries)"
	if [[ -z "$rows" ]]; then
		echo "no extensions declare a pi.cli — nothing to install"
		return 0
	fi
	mkdir -p "$BIN_DIR"
	while IFS=$'\t' read -r name abs ext; do
		[[ -n "$name" ]] || continue
		if [[ ! -f "$abs" ]]; then
			missing+=("$name → $abs")
			continue
		fi
		chmod +x "$abs"
		ln -sf "$abs" "$BIN_DIR/$name"
		printf "  ${G}linked${N} %-18s -> %s\n" "$name" "$abs"
		count=$((count + 1))
	done <<< "$rows"

	if [[ ${#missing[@]} -gt 0 ]]; then
		echo
		printf "${Y}warn:${N} %d entry(ies) missing on disk:\n" "${#missing[@]}"
		printf "  - %s\n" "${missing[@]}"
	fi

	# PATH hint
	case ":$PATH:" in
		*":$BIN_DIR:"*) ;;
		*)
			echo
			echo "${Y}note:${N} $BIN_DIR is not in PATH. Add to ~/.zshrc:"
			echo "  export PATH=\"$BIN_DIR:\$PATH\""
			;;
	esac

	# Node version sanity (TS shebangs need ≥ 22.6 for --experimental-strip-types).
	if command -v node >/dev/null 2>&1; then
		local node_ver major
		node_ver="$(node -v | sed 's/^v//')"
		major="${node_ver%%.*}"
		if (( major < 22 )); then
			echo
			echo "${Y}warn:${N} Node $node_ver — TS shebangs need ≥ 22.6"
		fi
	else
		echo
		echo "${Y}warn:${N} node not on PATH"
	fi

	echo
	printf "${G}installed %d CLI(s)${N} into %s\n" "$count" "$BIN_DIR"
}

cmd_uninstall() {
	local rows count=0
	rows="$(list_entries)"
	while IFS=$'\t' read -r name abs ext; do
		[[ -n "$name" ]] || continue
		local link="$BIN_DIR/$name"
		if [[ -L "$link" ]]; then
			# Only remove if it points into our extensions tree, to avoid
			# nuking an unrelated `pi-wf` someone else dropped in BIN_DIR.
			local target
			target="$(readlink -f "$link" 2>/dev/null || true)"
			if [[ "$target" == "$EXT_DIR/"* ]]; then
				rm -f "$link"
				printf "  ${R}removed${N} %s\n" "$link"
				count=$((count + 1))
			else
				printf "  ${Y}skipped${N} %s (not ours: -> %s)\n" "$link" "$target"
			fi
		elif [[ -e "$link" ]]; then
			printf "  ${Y}skipped${N} %s (not a symlink)\n" "$link"
		fi
	done <<< "$rows"
	printf "${R}removed %d symlink(s)${N}\n" "$count"
}

case "${1:-install}" in
	install)   cmd_install ;;
	--list|list|-l)        cmd_list ;;
	--uninstall|uninstall) cmd_uninstall ;;
	-h|--help|help)
		sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//;/^set -euo/d'
		;;
	*)
		echo "unknown: ${1}" >&2
		echo "use: $0 [install|--list|--uninstall|--help]" >&2
		exit 2
		;;
esac
