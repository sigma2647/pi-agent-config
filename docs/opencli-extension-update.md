# opencli 浏览器插件更新

`opencli doctor` 提示 `Extension update available` 时的更新流程。

## 一键更新

```bash
EXT_DIR=$(find ~/.config/chromium/Default/UnpackedExtensions -maxdepth 1 -name "opencli-extension-*" -type d | head -1)
if [ -z "$EXT_DIR" ]; then
  echo "插件未安装。先打开 chromium://extensions → Load unpacked → 选择扩展目录"
  exit 1
fi

# 获取最新插件 release tag（独立于 CLI release，用 ext-v* tag）
EXT_TAG=$(gh release list --repo jackwener/opencli --json tagName --jq '.[].tagName' | grep '^ext-v' | sort -V | tail -1)
echo "Latest extension tag: $EXT_TAG"

# 下载 zip
gh release download "$EXT_TAG" --repo jackwener/opencli --pattern 'opencli-extension-*.zip' --dir /tmp
ZIP_FILE=$(ls /tmp/opencli-extension-*.zip 2>/dev/null | head -1)

# 防御：验证 zip 存在且有效，才会删除旧目录
if [ ! -f "$ZIP_FILE" ]; then
  echo "下载失败：未找到 $ZIP_FILE"
  exit 1
fi
unzip -tq "$ZIP_FILE" || { echo "zip 损坏"; exit 1; }

# 原地覆盖（保持目录名不变，Chromium Preferences 中路径不变）
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
unzip -o -q "$ZIP_FILE" -d "$EXT_DIR"
rm -f "$ZIP_FILE"

echo "Updated. Refresh in chrome://extensions → OpenCLI → ↻"
grep '"version"' "$EXT_DIR/manifest.json"
opencli doctor
```

## 手动步骤

1. 查最新插件 release tag
   ```bash
   gh release list --repo jackwener/opencli --json tagName --jq '.[].tagName' | grep '^ext-v' | sort -V | tail -1
   ```

2. 下载并原地覆盖
   ```bash
   EXT_DIR=~/.config/chromium/Default/UnpackedExtensions/opencli-extension-*
   gh release download "ext-v1.0.21" --repo jackwener/opencli --pattern 'opencli-extension-*.zip' --dir /tmp
   rm -rf "$EXT_DIR" && unzip -o /tmp/opencli-extension-*.zip -d "$EXT_DIR" && rm -f /tmp/opencli-extension-*.zip
   ```

3. **重载插件**：打开 `chrome://extensions/`，找到 OpenCLI，点刷新 🔄

4. **验证**：`opencli doctor`

## 防御措施

更新脚本中最关键的两步必须加 pre-flight 检查：

| 步骤 | 风险 | 防御 |
|---|---|---|
| `gh release download` 拿到 zip 路径 | `head -1` / `gh release view` 在 `ext-v*` vs `v1.8.x` 两套 tag 下可能拿错 | 用 `grep '^ext-v'` + `sort -V \| tail -1` 精确过滤扩展 release tag |
| `rm -rf $EXT_DIR` | zip 下载失败 → 目录被删后没有东西解压 → 扩展丢失 | **`unzip -tq` 验证 zip 有效后才 `rm -rf`**；或用 `unzip -o` 直接覆盖（不先删目录） |

## 注意事项

- **原地覆盖**：保持插件目录名不变。Chromium 的 `Preferences` 中存的是绝对路径，换目录会导致插件显示为损坏。
- **Chromium vs Chrome**：Chromium 路径 `~/.config/chromium/`，Chrome 路径 `~/.config/google-chrome/`。
- **代理**：GitHub 下载可能需要 `--proxy http://127.0.0.1:7890`。用 `gh release download` 时走 `HTTP_PROXY` 环境变量。
- **版本号体系**：插件版本 (v1.0.x) 和 CLI 版本 (v1.8.x) 是独立的。自 2026-06-28 起，插件有独立的 `ext-v1.0.x` release tag，不再跟着 CLI tag 发。`gh release list` 中 `ext-v...` 字母序排在 `v...` 之前，**不要用 `head -1` 取最新 tag**，必须过滤 `grep '^ext-v'`。
- **插件重装**：如果插件在 chrome://extensions 里消失了（比如 `rm -rf` 时 Chrome 正在运行），需要重新 `Load unpacked` 指向同一目录。
