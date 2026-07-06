# opencli Browser Bridge 扩展安装 & 更新

## 首次安装

Chromium 首次加载扩展分为两步：下载解压 → `chrome://extensions` 手动加载。**解压后必须立刻加载**，否则 Chromium 会清理掉未注册的 `UnpackedExtensions/` 目录。

```bash
# 1. 查最新插件 release tag（独立于 CLI release，用 ext-v* tag）
EXT_TAG=$(gh release list --repo jackwener/opencli --json tagName --jq '.[].tagName' | grep '^ext-v' | sort -V | tail -1)
echo "Latest extension tag: $EXT_TAG"

# 2. 下载 zip
gh release download "$EXT_TAG" --repo jackwener/opencli --pattern 'opencli-extension-*.zip' --dir /tmp
ZIP_FILE=$(ls /tmp/opencli-extension-*.zip 2>/dev/null | head -1)

# 防御：验证 zip 存在且有效
if [ ! -f "$ZIP_FILE" ]; then
  echo "下载失败：未找到 $ZIP_FILE"
  exit 1
fi
unzip -tq "$ZIP_FILE" || { echo "zip 损坏"; exit 1; }

# 3. 解压到固定位置（目录名不含版本号，避免 Chromium Preferences 路径变化）
EXT_DIR="$HOME/.config/chromium/Default/UnpackedExtensions/opencli-extension"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
unzip -o -q "$ZIP_FILE" -d "$EXT_DIR"
rm -f "$ZIP_FILE"

# 4. **立刻**在 Chromium 中加载（否则目录会被清理！）
#    chrome://extensions/ → 开启 Developer Mode → Load unpacked → 选择 ~/.config/chromium/Default/UnpackedExtensions/opencli-extension
```

加载后验证：

```bash
opencli daemon restart   # 重启 daemon 连接新扩展
opencli doctor
# 期望：[OK] Extension: connected
```

## 更新已安装的扩展

扩展已注册在 Chromium Preferences 中 → 目录不会被清理，可以安全地原地覆盖。

```bash
# 1. 定位现有目录
EXT_DIR=$(find ~/.config/chromium -path '*/UnpackedExtensions/*opencli*' -maxdepth 5 -type d 2>/dev/null | head -1)
if [ -z "$EXT_DIR" ]; then
  echo "Extension not found — use '首次安装' 步骤"
  exit 1
fi

# 2. 读当前版本 → 查最新版本
CURRENT=$(grep -oP '"version"\s*:\s*"\K[^"]+' "$EXT_DIR/manifest.json")
EXT_TAG=$(gh release list --repo jackwener/opencli --json tagName --jq '.[].tagName' | grep '^ext-v' | sort -V | tail -1)
LATEST_VER=${EXT_TAG#ext-v}

if [ "$CURRENT" = "$LATEST_VER" ]; then
  echo "Already up to date (v$CURRENT)"
  exit 0
fi
echo "Updating: v$CURRENT → v$LATEST_VER"

# 3. 下载 zip
gh release download "$EXT_TAG" --repo jackwener/opencli --pattern 'opencli-extension-*.zip' --dir /tmp
ZIP_FILE=$(ls /tmp/opencli-extension-*.zip 2>/dev/null | head -1)

# 防御：验证 zip 有效后才覆盖
if [ ! -f "$ZIP_FILE" ]; then
  echo "下载失败：未找到 $ZIP_FILE"
  exit 1
fi
unzip -tq "$ZIP_FILE" || { echo "zip 损坏"; exit 1; }

# 4. 原地覆盖（保持目录名不变，Chromium Preferences 中路径不变）
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
unzip -o -q "$ZIP_FILE" -d "$EXT_DIR"
rm -f "$ZIP_FILE"

# 5. Chromium 不会自动 reload → 手动刷新
echo "Updated to v$LATEST_VER. Refresh in chrome://extensions → OpenCLI → ↻"
grep '"version"' "$EXT_DIR/manifest.json"

# 6. 验证
opencli doctor
```

## 防御措施

更新脚本中最关键的两步必须加 pre-flight 检查：

| 步骤 | 风险 | 防御 |
|---|---|---|
| `gh release download` 拿到 zip 路径 | `head -1` 在 `ext-v*` vs `v1.8.x` 两套 tag 下可能拿错 | 用 `grep '^ext-v'` + `sort -V \| tail -1` 精确过滤扩展 release tag |
| `rm -rf $EXT_DIR` | zip 下载失败 → 目录被删后没有东西解压 → 扩展丢失 | **`unzip -tq` 验证 zip 有效后才 `rm -rf`** |

## 注意事项

- **不要自己拼下载 URL**：扩展 zip 可能挂在 `ext-v*` 自己的 release tag 下，也可能附在 CLI `v1.8.x` 的 release 里。用 `gh release download` + 精确 tag 过滤，不要从 tag 格式推导 URL。
- **原地覆盖**：更新时保持插件目录名不变。Chromium 的 `Preferences` 中存的是绝对路径，换目录会导致插件显示为损坏。
- **Chromium 清理**：`UnpackedExtensions/` 下未在 Preferences 注册的目录会被 Chromium 定期清理。**首次安装解压后必须立刻加载，不要中间干别的事。**
- **Chromium vs Chrome**：Chromium 路径 `~/.config/chromium/`，Chrome 路径 `~/.config/google-chrome/`。
- **代理**：GitHub 下载可能需要代理。`gh release download` 走 `HTTP_PROXY` 环境变量（已通过 shebang 的 `NODE_USE_ENV_PROXY=1` 生效）。
- **版本号体系**：插件版本 (v1.0.x) 和 CLI 版本 (v1.8.x) 是独立的。插件的 release tag 是 `ext-v1.0.x`，CLI 的 release tag 是 `v1.8.x`。
- **Chrome 不会自动 reload**：更新文件后需手动去 `chrome://extensions/` 点刷新 🔄。
