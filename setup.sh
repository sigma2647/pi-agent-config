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

# ---------- 4. symlink top-level config files into ~/.pi/agent ----------
for f in settings.json models.json presets.json AGENTS.md; do
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

# ---------- 5. register this repo as a pi package ----------
pi install "$REPO_DIR"
echo "Installed as pi package"

echo "Done. Config linked to $PI_DIR"

# ---------- optional backends (web_search) ----------
cat <<'EOF'

Optional for web_search backends:
  - opencli         : npm install -g opencli  (then `opencli login` for sites that need it)
  - brave           : export BRAVE_SEARCH_API_KEY=...
  - browser-harness : npm install -g browser-harness   (or rely on playwright in PATH)
EOF
