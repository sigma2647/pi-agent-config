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

## 配置：一个模型一个文件

配置是插件目录下的 `prompts/` 目录，不用改代码、不用改 JSON：

```text
prompts/
  _default.md                      ← 所有模型都加
  deepseek/
    deepseek-flash.md              ← deepseek/deepseek-flash
  zai/
    glm-5.3-flashx.md              ← zai/glm-5.3-flashx
    _default.md                    ← zai 下所有模型（原来的 zai/*）
  local-claude/
    _default.md                    ← local-claude 下所有模型
```

文件名就是模型 id，一个字都不能错（大小写敏感）。新建一个模型的支持 = 新建一个文件。

用 `PI_MODEL_PROMPTS_DIR` 可把整个目录指到别处（例如放个人私有提示词）。

## 匹配顺序

按模型 `ctx.model` 找第一个**存在且非空**的文件：

1. `prompts/<provider>/<modelId>.md`
2. `prompts/<provider>/_default.md`
3. `prompts/_default.md`

都没命中就什么都不加。每次请求重新读文件，改完立即生效，不用重启。

## 行为

- 只做加法：写一个段落，不整体替换 system prompt。这样 pi 仍能增量记录结构化段落，
  提示词前缀保持稳定（DeepSeek 按前缀缓存计价，前缀变了就全额付费）。
- 文件缺失、为空或无命中 → 什么都不做，不打断会话。
- `/model-prompt` 显示当前模型读到了哪个文件。不命中通常是路径或文件名写错。

## 注意

写 `systemPromptOptions.sections` 是加法；如果确实要整段替换，才用返回
`{ systemPrompt }` 的写法，代价是丢掉 pi 自动追加的 transcript 增量。

旧版用 `model-prompts.json`（一个文件里塞所有键），已删除。把 JSON 的键翻成路径即可：
`provider/modelId` → `<provider>/<modelId>.md`，`provider/*` → `<provider>/_default.md`，
`*` → `_default.md`。
