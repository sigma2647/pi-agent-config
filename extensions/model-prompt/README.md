# model-prompt

按模型给系统提示词追加一段专属内容（`<model_guidance>`）。这是一个可单独安装的 pi 插件。

pi 没有「按模型换系统提示词」的设置项（`settings.md` 里只有 `modelThinkingLevels`、
`compaction.modelOverrides`）。本插件用 `before_agent_start` 事件补上：处理器里
`ctx.model` 就是本次要跑的模型，命中的文本写进 `systemPromptOptions.sections`。

## 安装

```bash
pi install /home/lawrence/pi-agent-config/extensions/model-prompt
pi remove /home/lawrence/pi-agent-config/extensions/model-prompt   # 卸载
```

仓库根目录的 `package.json` **不再**登记它（否则会和单独安装重复加载）。放回
`pi.extensions` 列表即可改回「跟着仓库一起加载」。

## 配置

同目录下的 `model-prompts.json`，不往 `~/.pi/agent` 放东西。用 `PI_MODEL_PROMPTS`
可换路径。

```json
{
  "deepseek/deepseek-flash": "回答用中文，短句，先说结论。",
  "deepseek/*": "provider 级兜底",
  "*": "所有模型都加"
}
```

键的匹配顺序：`provider/modelId` → `modelId` → `provider/*` → `*`，第一个命中的生效。
值是一段文本。每次请求重新读文件，改完立即生效，不用重启。

## 行为

- 只做加法：写一个段落，不整体替换 system prompt。这样 pi 仍能增量记录结构化段落，
  提示词前缀保持稳定（DeepSeek 按前缀缓存计价，前缀变了就全额付费）。
- 配置缺失、损坏或无命中 → 什么都不做，不打断会话。
- `/model-prompt` 显示当前模型命中了哪条规则。不命中通常是键写错了。

## 注意

写 `systemPromptOptions.sections` 是加法；如果确实要整段替换，才用返回
`{ systemPrompt }` 的写法，代价是丢掉 pi 自动追加的 transcript 增量。
