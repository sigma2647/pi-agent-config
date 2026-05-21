#!/usr/bin/env bash
set -euo pipefail

PI_DIR="$HOME/.pi/agent"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_PKG="@earendil-works/pi-coding-agent"

mkdir -p "$PI_DIR"

# ---------- 1. Node.js required ----------
if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node not found. Install Node.js first (recommended: volta install node)." >&2
    exit 1
fi

# ---------- 2. install pi globally if missing ----------
if ! command -v pi >/dev/null 2>&1; then
    echo "Installing $PI_PKG globally..."
    npm install -g "$PI_PKG"
fi

# ---------- 3. install repo-local deps (typebox, vscode-languageserver-protocol) ----------
if [[ -f "$REPO_DIR/package.json" ]]; then
    echo "Installing repo dependencies..."
    (cd "$REPO_DIR" && npm install --silent)
fi

# ---------- 4. merge repo preferences into ~/.pi/agent/settings.json ----------
# pi writes back into ~/.pi/agent/settings.json (packages, lastChangelogVersion, ...),
# so symlinking a tracked file pollutes the repo on every run. Merge instead:
# repo prefs win for declared keys; everything else in the live file is preserved.
SRC_SETTINGS="$REPO_DIR/settings.json"
DST_SETTINGS="$PI_DIR/settings.json"
if [[ -f "$SRC_SETTINGS" ]]; then
    # If a previous setup left a symlink here, replace it with a real file.
    if [[ -L "$DST_SETTINGS" ]]; then
        mv "$DST_SETTINGS" "$DST_SETTINGS.bak.$(date +%s)"
        echo "Backup settings.json symlink -> settings.json.bak.*"
    fi
    node - "$SRC_SETTINGS" "$DST_SETTINGS" <<'NODE'
const fs = require("node:fs");
const [, , src, dst] = process.argv;
const srcCfg = JSON.parse(fs.readFileSync(src, "utf8"));
let dstCfg = {};
if (fs.existsSync(dst)) {
    try { dstCfg = JSON.parse(fs.readFileSync(dst, "utf8")); } catch {}
}
const merged = { ...dstCfg, ...srcCfg };
fs.writeFileSync(dst, JSON.stringify(merged, null, 2) + "\n");
NODE
    echo "Merge  settings.json"
fi

# ---------- 5. symlink read-only config files ----------
# These are never written by pi, so symlinks are safe and let edits in the repo
# take effect immediately.
for f in models.json presets.json AGENTS.md; do
    src="$REPO_DIR/$f"
    dst="$PI_DIR/$f"
    [[ -f "$src" ]] || continue

    if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
        echo "OK     $f"
        continue
    fi
    if [[ -e "$dst" || -L "$dst" ]]; then
        mv "$dst" "$dst.bak.$(date +%s)"
        echo "Backup $f -> $f.bak.*"
    fi
    ln -s "$src" "$dst"
    echo "Link   $f"
done

# ---------- 6. register this repo as a pi package ----------
# pi writes the absolute path into ~/.pi/agent/settings.json's `packages` array.
# Extensions, skills, prompts, and themes load from this repo in-place on every
# pi startup — they do NOT get copied into ~/.pi/agent/extensions/.
pi install "$REPO_DIR"

echo "Done. Config installed at $PI_DIR"
echo "Extensions load from: $REPO_DIR/extensions (verify with: pi list)"

# ---------- optional backends (web_search) ----------
cat <<'EOF'

Optional for web_search backends:
  - opencli         : npm install -g opencli  (then `opencli login` for sites that need it)
  - brave           : export BRAVE_SEARCH_API_KEY=...
  - browser-harness : npm install -g browser-harness   (or rely on playwright in PATH)
EOF
