#!/usr/bin/env bash
set -euo pipefail

PI_DIR="$HOME/.pi/agent"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$PI_DIR"

for f in settings.json models.json presets.json AGENTS.md; do
    src="$REPO_DIR/$f"
    dst="$PI_DIR/$f"
    [[ -f "$src" ]] || continue
    
    # 已经是指向我们的 symlink 就跳过
    if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
        echo "OK     $f"
        continue
    fi
    # 存在但不是我们的 symlink,备份
    if [[ -e "$dst" || -L "$dst" ]]; then
        mv "$dst" "$dst.bak.$(date +%s)"
        echo "Backup $f -> $f.bak.*"
    fi
    ln -s "$src" "$dst"
    echo "Link   $f"
done


# Install as pi package for extensions, skills, prompts, and themes
if command -v pi >/dev/null 2>&1; then
    pi install "$REPO_DIR"
    echo "Installed as pi package"
else
    echo "Warning: pi not found. Install pi and run: pi install $REPO_DIR"
fi

echo "Done. Config linked to $PI_DIR"
