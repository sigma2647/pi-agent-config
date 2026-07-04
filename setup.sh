#!/usr/bin/env bash
# setup.sh — wire pi-agent-config into ~/.pi/agent/
#
# 用法:
#   ./setup.sh             # 安装/更新
#   ./setup.sh --dry-run   # 只打印将要做的操作
#   ./setup.sh --force     # 覆盖已存在的非 symlink 文件 (会先备份)
#   ./setup.sh --unlink    # 移除本脚本创建的 symlink, 并卸载 pi package
#
# 设计要点:
#   - settings.json 是 MERGE 进活动文件, 不 symlink。pi 会写回它
#     (packages / lastChangelogVersion / ...), symlink 会污染仓库。
#   - extensions/ skills/ prompts/ themes/ 不 symlink。pi install 把仓库
#     注册为 package, 这些目录由 pi 从 package 路径加载, 再 symlink 到
#     ~/.pi/agent/<name>/ 会被全局自动发现机制重复加载。
#   - 只 symlink 真正只读的文件 (models.json / presets.json / *.md / keybindings.json / mcp.json)。

set -euo pipefail

# ---------- 配置 ----------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PI_PKG="@earendil-works/pi-coding-agent"
BACKUP_DIR="$PI_DIR/.backup/$(date +%Y%m%d-%H%M%S)"

# pi 永远不写的文件 — 可以 symlink。pi 写的 (settings.json) 走 merge。
LINK_FILES=(
  "models.json"
  "presets.json"
  "AGENTS.md"
  "SYSTEM.md"
  "keybindings.json"
  "mcp.json"
)

# 永远不碰的本机敏感数据。
PROTECTED=(
  "auth.json"
  "sessions"
  ".backup"
  "git"
  "npm"
)
# ---------- 配置结束 ----------

DRY_RUN=0
FORCE=0
UNLINK=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    --unlink)  UNLINK=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

if [ -t 1 ]; then
  C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_GRN=""; C_YLW=""; C_RED=""; C_DIM=""; C_RST=""
fi

info() { echo "${C_GRN}==>${C_RST} $*"; }
warn() { echo "${C_YLW}warn:${C_RST} $*" >&2; }
err()  { echo "${C_RED}error:${C_RST} $*" >&2; }
run()  { if [ "$DRY_RUN" = 1 ]; then echo "${C_DIM}[dry-run] $*${C_RST}"; else eval "$@"; fi; }

is_protected() {
  local name="$1"
  for p in "${PROTECTED[@]}"; do
    [ "$name" = "$p" ] && return 0
  done
  return 1
}

backup_existing() {
  local target="$1"
  local name; name="$(basename "$target")"
  run "mkdir -p \"$BACKUP_DIR\""
  warn "已存在: $target -> $BACKUP_DIR/$name"
  run "mv \"$target\" \"$BACKUP_DIR/$name\""
}

link_one() {
  local src="$1" dst="$2"
  local name; name="$(basename "$dst")"

  if is_protected "$name"; then
    warn "受保护项, 跳过: $name"
    return
  fi
  if [ ! -e "$src" ]; then
    echo "${C_DIM}skip (源不存在): $name${C_RST}"
    return
  fi

  if [ -L "$dst" ]; then
    local cur; cur="$(readlink "$dst")"
    if [ "$cur" = "$src" ]; then
      echo "${C_DIM}ok    $name${C_RST}"
      return
    fi
    warn "symlink 指向别处: $dst -> $cur, 替换"
    run "rm \"$dst\""
  elif [ -e "$dst" ]; then
    if [ "$FORCE" = 1 ]; then
      backup_existing "$dst"
    else
      err "$dst 已存在且不是 symlink。用 --force 自动备份。"
      exit 1
    fi
  fi

  info "link  $name"
  run "ln -s \"$src\" \"$dst\""
}

merge_settings() {
  local src="$REPO_DIR/settings.json"
  local dst="$PI_DIR/settings.json"
  [ -f "$src" ] || return 0

  # 旧 setup 可能留下了 symlink, 替换成真实文件以防 pi 写穿仓库。
  if [ -L "$dst" ]; then
    backup_existing "$dst"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    echo "${C_DIM}[dry-run] merge $src -> $dst${C_RST}"
    return
  fi

  node - "$src" "$dst" <<'NODE'
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
  info "merge settings.json"
}

unlink_all() {
  info "移除指向 $REPO_DIR 的 symlink"
  shopt -s nullglob
  for f in "$PI_DIR"/* "$PI_DIR"/.[!.]*; do
    [ -L "$f" ] || continue
    local target; target="$(readlink "$f")"
    case "$target" in
      "$REPO_DIR"/*)
        info "unlink $(basename "$f")"
        run "rm \"$f\""
        ;;
    esac
  done

  if command -v pi >/dev/null 2>&1; then
    info "pi remove $REPO_DIR"
    if [ "$DRY_RUN" = 1 ]; then
      echo "${C_DIM}[dry-run] pi remove \"$REPO_DIR\"${C_RST}"
    else
      pi remove "$REPO_DIR" || warn "pi remove 失败, 可手动执行"
    fi
  fi
  warn "settings.json 不会被还原 (它是合并产物), 如需清理请手动删除 $PI_DIR/settings.json"
}

main() {
  info "仓库: $REPO_DIR"
  info "目标: $PI_DIR"
  [ "$DRY_RUN" = 1 ] && warn "dry-run 模式, 不会实际改动"
  echo

  run "mkdir -p \"$PI_DIR\""

  if [ "$UNLINK" = 1 ]; then
    unlink_all
    info "完成。"
    exit 0
  fi

  # 1. Node 必须先有
  if ! command -v node >/dev/null 2>&1; then
    err "node 未安装。先装 Node.js (推荐 volta install node)。"
    exit 1
  fi

  # 2. 全局装 pi (缺则装)
  if ! command -v pi >/dev/null 2>&1; then
    info "全局安装 $PI_PKG"
    if [ "$DRY_RUN" = 1 ]; then
      echo "${C_DIM}[dry-run] npm install -g $PI_PKG${C_RST}"
    else
      npm install -g "$PI_PKG"
    fi
  fi

  # 3. repo 依赖
  if [ -f "$REPO_DIR/package.json" ]; then
    info "安装 repo 依赖"
    if [ "$DRY_RUN" = 1 ]; then
      echo "${C_DIM}[dry-run] (cd $REPO_DIR && npm install --silent)${C_RST}"
    else
      (cd "$REPO_DIR" && npm install --silent)
    fi
  fi

  # 3.5 扩展子目录依赖 (各自有 package.json)
  if [ -d "$REPO_DIR/extensions" ]; then
    for ext_pkg in "$REPO_DIR"/extensions/*/package.json; do
      [ -f "$ext_pkg" ] || continue
      local ext_dir; ext_dir="$(dirname "$ext_pkg")"
      # 有 dependencies 才装
      if node -e "const p=require('$ext_pkg');process.exit(p.dependencies?0:1)" 2>/dev/null; then
        info "安装扩展依赖: extensions/$(basename "$ext_dir")"
        if [ "$DRY_RUN" = 1 ]; then
          echo "${C_DIM}[dry-run] (cd $ext_dir && npm install --silent)${C_RST}"
        else
          (cd "$ext_dir" && npm install --silent)
        fi
      fi
    done
  fi

  # 4. settings.json 合并 (不 symlink)
  merge_settings

  # 5. 只读文件 symlink
  for f in "${LINK_FILES[@]}"; do
    link_one "$REPO_DIR/$f" "$PI_DIR/$f"
  done

  # 6. 把仓库注册为 pi package。extensions/skills/prompts/themes
  #    由 pi 从这个 package 路径加载, 无需 symlink。
  if command -v pi >/dev/null 2>&1 && [ -f "$REPO_DIR/package.json" ]; then
    info "pi install $REPO_DIR"
    if [ "$DRY_RUN" = 1 ]; then
      echo "${C_DIM}[dry-run] pi install \"$REPO_DIR\"${C_RST}"
    else
      pi install "$REPO_DIR" || warn "pi install 失败, 可手动执行"
    fi
  fi

  echo
  info "完成。Extensions 从 $REPO_DIR/extensions 加载 (pi list 验证)"

  if [ ! -e "$PI_DIR/auth.json" ]; then
    cat <<EOF

${C_YLW}下一步${C_RST}: 创建 $PI_DIR/auth.json (不要进 git):

  {
    "anthropic": { "type": "api_key", "key": "sk-ant-..." }
  }

或运行 pi 后用 /login。
EOF
  fi

  cat <<'EOF'

Optional for web_search backends:
  - opencli         : npm install -g opencli  (then `opencli login` for sites that need it)
  - brave           : export BRAVE_SEARCH_API_KEY=...
  - browser-harness : npm install -g browser-harness   (or rely on playwright in PATH)
EOF
}

main "$@"
