# opencli 浏览器插件更新

`opencli doctor` 提示 `Extension update available` 时的更新流程。

## 一键更新

```bash
# 1. 获取最新版本号（从 doctor 输出或 gh release）
LATEST=$(gh release view --repo jackwener/opencli --json assets | jq -r '.assets[] | select(.name | test("opencli-extension")) | .name' | sed 's/opencli-extension-v//;s/.zip//' | head -1)
echo "Latest extension: v$LATEST"

# 2. 找到当前插件目录
EXT_DIR=$(find ~/.config/chromium/Default/UnpackedExtensions -maxdepth 1 -name "opencli-extension-*" -type d | head -1)
echo "Current extension dir: $EXT_DIR"

# 3. 原地覆盖更新（保持路径不变，Chromium 无需重新加载路径）
curl -L --proxy http://127.0.0.1:7890 -o /tmp/opencli-extension.zip \
  "https://github.com/jackwener/OpenCLI/releases/download/v1.8.3/opencli-extension-v${LATEST}.zip"
unzip -o -q /tmp/opencli-extension.zip -d "$EXT_DIR"

# 4. Chromium: chrome://extensions/ → 点击 OpenCLI 的刷新按钮 🔄

# 5. 验证
opencli doctor
```

## 手动步骤

1. **获取最新插件 zip**
   ```bash
   gh release view --repo jackwener/opencli --json assets | jq '.assets[] | select(.name | test("opencli-extension"))'
   ```

2. **下载并原地覆盖**
   ```bash
   EXT_DIR=~/.config/chromium/Default/UnpackedExtensions/opencli-extension-v1.0.15_*
   unzip -o opencli-extension-v1.0.19.zip -d $EXT_DIR
   ```

3. **重载插件**：打开 `chrome://extensions/`，找到 OpenCLI，点刷新 🔄

4. **验证**：`opencli doctor`

## 注意事项

- **原地覆盖**：保持插件目录名不变。Chromium 的 `Preferences` 中存的是绝对路径，换目录会导致插件显示为损坏。
- **Chromium vs Chrome**：Chromium 路径 `~/.config/chromium/`，Chrome 路径 `~/.config/google-chrome/`。
- **代理**：GitHub 下载可能需要 `--proxy http://127.0.0.1:7890`。
- **版本号体系**：插件版本 (v1.0.x) 和 CLI 版本 (v1.8.x) 是独立的。
