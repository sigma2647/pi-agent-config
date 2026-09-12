参考 https://github.com/KnockOutEZ/wigolo
https://mp.weixin.qq.com/s/XKaVONMRxMyLA7nMu_SrtA

https://github.com/elpapi42/pi-observational-memory

## 2026-09-12 dictation 改动的 code review 发现

- [x] **README（dictation）的 `keybindMode` 默认值写错**：已按「保留代码默认 `toggle`、改文档」处理：默认值不依赖终端能力最安全，想要长按的人改一行配置即可。
- [ ] **热键提示在「模型已下载但 sherpa-onnx 没装」时误导人**：按 ctrl+r 走的是 `strings.error.noProvider`（「1) 下载本地模型；2) 配置云端 Key」），而真实原因是运行时装缺失。`showStatus` 已会列出每个未就绪服务的详情，热键路径没有；建议把未就绪详情拼进这条通知（`core.ts:notReadyHint` 已有同样的思路，可以复用）。
- [ ] **删掉不可达的 `noModel` 分支**：`index.ts` 的 `resolved.config.type === "local" && !modelState(...).ready` 永远为假，因为 `resolveProvider` 只返回 ready 的 provider（改前改后都是如此）。连带 `strings.error.noModel` 永不触发，且它把 155 MB 写死、参数 `id` 没用上。
- [ ] **`pi-dictation model use` 没有自动化用例**：只有手动验证；`dev.ts` 目前没有测试脚手架（新加的分支至少可以测 `setLocalModel` 的返回映射）。
- [ ] **模型列表措辞歧义**：配置指向一个未下载的模型时，同一行同时显示「当前使用」和「未下载」。事实没错（配置就是这么写的），但容易读成「正在用且可用」；可考虑改成「当前配置」。
- [ ] **英文用词两处维护**：`dev.ts` 里模型列表的英文（`current` / `not downloaded` / `text after you stop`）是内联常量，和 `strings.ts` 的 `en` 重复。可改为 `resolveStrings(config.locale)`，或抽一个共享常量。
