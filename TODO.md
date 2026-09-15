参考 https://github.com/KnockOutEZ/wigolo
https://mp.weixin.qq.com/s/XKaVONMRxMyLA7nMu_SrtA

https://github.com/elpapi42/pi-observational-memory

## 2026-09-12 dictation 改动的 code review 发现

- [x] **README（dictation）的 `keybindMode` 默认值写错**：已按「保留代码默认 `toggle`、改文档」处理：默认值不依赖终端能力最安全，想要长按的人改一行配置即可。
- [x] **热键提示在「模型已下载但 sherpa-onnx 没装」时误导人**：已把 `core.ts:notReadyHint` 导出并接进热键和启动两条 `noProvider` 路径：指定了服务时直接报真实原因（运行时缺失／缺 Key），auto 时才给两条通用建议。
- [x] **删掉不可达的 `noModel` 分支**：已删（`resolveProvider` 只返回 ready 的 provider，分支永假），`strings.error.noModel` 一并移除。
- [x] **`pi-dictation model use` 没有自动化用例**：已加 CLI 冒烟测试（`test/cli.test.ts`）：真实子进程跑 `model use`／`mode`，断言退出码、输出和写回的配置文件。
- [x] **模型列表措辞歧义**：已改为「← 当前配置」（英文 `← configured`）：配置指向未下载模型时不再读成「正在用且可用」。
- [x] **英文用词两处维护**：已改用 `resolveStrings(config.locale)`；顺带把列表里「未下载的先 download」提示找了回来。
