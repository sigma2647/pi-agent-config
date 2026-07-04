# opencli Browser Bridge 扩展安装 & 更新

## 首次安装

Chromium 首次加载扩展分为两步：下载解压 → `chrome://extensions` 手动加载。**解压后必须立刻加载**，否则 Chromium 会清理掉未注册的 `UnpackedExtensions/` 目录。

```bash
# 1. 查最新插件 zip 的下载 URL（不要自己拼 URL——zip 可能挂在 ext-v* 或 CLI v1.8.x 的 release 下）
ASSET=$(curl -sL --proxy http://127.0.0.1:7890 \
  "https://api.github.com/repos/jackwener/opencli/releases?per_page=5" \
  | jq -r '[.[].assets[] | select(.name | test("opencli-extension.*\\.zip$"))] | sort_by(.updated_at) | last')
LATEST_VER=$(echo "$ASSET" | jq -r '.name' | sed 's/opencli-extension-v//;s/\.zip//')
ZIP_URL=$(echo "$ASSET" | jq -r '.browser_download_url')
echo "Latest extension: v$LATEST_VER"

# 2. 下载解压
EXT_DIR="$HOME/.config/chromium/Default/UnpackedExtensions/opencli-extension-v${LATEST_VER}"
mkdir -p "$EXT_DIR"
curl -sL --proxy http://127.0.0.1:7890 -o /tmp/opencli-extension.zip "$ZIP_URL"
unzip -o -q /tmp/opencli-extension.zip -d "$EXT_DIR" && rm -f /tmp/opencli-extension.zip
echo "Extracted to: $EXT_DIR"

# 3. 立刻在 Chromium 中加载（否则目录会被清理！）
#    chrome://extensions/ → 开启 Developer Mode → Load unpacked → 选上面的目录
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
ASSET=$(curl -sL --proxy http://127.0.0.1:7890 \
  "https://api.github.com/repos/jackwener/opencli/releases?per_page=5" \
  | jq -r '[.[].assets[] | select(.name | test("opencli-extension.*\\.zip$"))] | sort_by(.updated_at) | last')
LATEST_VER=$(echo "$ASSET" | jq -r '.name' | sed 's/opencli-extension-v//;s/\.zip//')
ZIP_URL=$(echo "$ASSET" | jq -r '.browser_download_url')

if [ "$CURRENT" = "$LATEST_VER" ]; then
  echo "Already up to date (v$CURRENT)"
  exit 0
fi
echo "Updating: v$CURRENT → v$LATEST_VER"

# 3. 下载并原地覆盖
curl -sL --proxy http://127.0.0.1:7890 -o /tmp/opencli-extension.zip "$ZIP_URL"
unzip -o -q /tmp/opencli-extension.zip -d "$EXT_DIR" && rm -f /tmp/opencli-extension.zip

# 4. Chromium: chrome://extensions/ → 点 OpenCLI 的刷新按钮 🔄

# 5. 验证
opencli doctor
```

如果 `gh` 已登录，可以替代步骤 2 的 curl 版本查询：

```bash
ASSET=$(gh release list --repo jackwener/opencli --json tagName,assets --jq \
  '[.[].assets[] | select(.name | test("opencli-extension.*\\.zip$"))] | sort_by(.updatedAt) | last')
```

## 注意事项

- **不要自己拼下载 URL**：扩展 zip 可能挂在 `ext-v*` 自己的 release tag 下，也可能附在 CLI `v1.8.x` 的 release 里。直接用 API 拿 `browser_download_url`，不要从 tag 格式推导。
- **原地覆盖**：更新时保持插件目录名不变。Chromium 的 `Preferences` 中存的是绝对路径，换目录会导致插件显示为损坏。
- **Chromium 清理**：`UnpackedExtensions/` 下未在 Preferences 注册的目录会被 Chromium 定期清理。**首次安装解压后必须立刻加载，不要中间干别的事。**
- **Chromium vs Chrome**：Chromium 路径 `~/.config/chromium/`，Chrome 路径 `~/.config/google-chrome/`。
- **代理**：GitHub 下载需要 `--proxy http://127.0.0.1:7890`。
- **版本号体系**：插件版本 (v1.0.x) 和 CLI 版本 (v1.8.x) 是独立的。
- **Chrome 不会自动 reload**：更新文件后需手动去 `chrome://extensions/` 点刷新 🔄。
