# Pi 全局上下文文件调研

调研日期：2026-07-20

## 结论

Pi 将项目上下文和系统提示词分成三类文件：

| 文件 | 作用 | 推荐内容 |
|---|---|---|
| `~/.pi/agent/AGENTS.md` | 所有项目共享的上下文 | 工作环境、常用技术栈、通用开发约定 |
| `~/.pi/agent/APPEND_SYSTEM.md` | 追加到 Pi 默认 system prompt | 行为、语气、安全边界、验证原则、工具偏好 |
| `~/.pi/agent/SYSTEM.md` | 完全替换 Pi 默认 system prompt | 单用途 Agent 的完整角色和工作流 |

项目级 `AGENTS.md` 用于项目结构、命令、架构、测试和部署规则；项目还可以用 `.pi/APPEND_SYSTEM.md` 添加只在该项目生效的行为约束。

普通编码环境优先使用 `AGENTS.md` 和 `APPEND_SYSTEM.md`。只有需要把 Pi 变成新闻抓取器、文本校正器等单用途 Agent 时，才使用 `SYSTEM.md`。

## Pi 的加载规则

Pi 启动时加载：

1. `~/.pi/agent/AGENTS.md`；
2. 从文件系统根目录到当前工作目录，逐级加载各目录中的 `AGENTS.md` 或 `CLAUDE.md`。

`--no-context-files` 或 `-nc` 可禁用 `AGENTS.md`/`CLAUDE.md`。修改上下文文件后可以执行 `/reload`。

System prompt 文件分为：

- 项目替换：`.pi/SYSTEM.md`；
- 全局替换：`~/.pi/agent/SYSTEM.md`；
- 项目追加：`.pi/APPEND_SYSTEM.md`；
- 全局追加：`~/.pi/agent/APPEND_SYSTEM.md`。

`PI_CODING_AGENT_DIR` 会覆盖默认的 `~/.pi/agent` 配置目录。

官方文档：

- [Pi README：Context Files](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#context-files)
- [Pi 使用文档：Context Files](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md#context-files)

## 公开实例

### DeepakNess：最小全局分层

[Setting Up and Using the Pi Coding Agent](https://deepakness.com/blog/pi-agent-setup/)

其全局 `AGENTS.md` 只记录常用技术栈，并要求优先读取项目自己的 `AGENTS.md`；全局 `APPEND_SYSTEM.md` 则规定本地文件优先、联网前确认、危险操作说明和写作风格。

这是最清晰的分层：环境事实进入 `AGENTS.md`，跨项目行为进入 `APPEND_SYSTEM.md`。

### rfgamaral/pi-config：个人全局配置

- [AGENTS.md](https://github.com/rfgamaral/pi-config/blob/main/AGENTS.md)
- [APPEND_SYSTEM.md](https://github.com/rfgamaral/pi-config/blob/main/APPEND_SYSTEM.md)

`AGENTS.md` 包含仓库约定检查、commit/PR 规则和特定工作目录规则；`APPEND_SYSTEM.md` 包含回答风格、禁止猜测、验证要求、执行边界和范围控制。

### njbrake/dotpi：Git 管理后链接到 Pi 配置目录

- [AGENTS.md](https://github.com/njbrake/dotpi/blob/main/AGENTS.md)
- [APPEND_SYSTEM.md](https://github.com/njbrake/dotpi/blob/main/APPEND_SYSTEM.md)
- [README](https://github.com/njbrake/dotpi)

该仓库明确记录 `~/.pi/agent/` 由 `~/pi-config/` 中的文件通过符号链接提供。`AGENTS.md` 保存环境和开发约定，`APPEND_SYSTEM.md` 保存验证、测试、Git/GitHub 操作等行为规则。

这与本仓库“Git 管理源文件，安装脚本链接到 Pi 全局目录”的需求最接近。

### Christian Lempa：只使用全局 APPEND_SYSTEM.md

[公开文件](https://github.com/ChristianLempa/dotfiles/blob/main/.pi/agent/APPEND_SYSTEM.md)

内容包括命令偏好、图表输出形式、subagent 工具选择，以及编码前判断需求合理性和避免过度设计。说明没有环境上下文时，可以只维护 `APPEND_SYSTEM.md`。

### Frappe CRM：项目级 APPEND_SYSTEM.md

[frappe/crm/.pi/APPEND_SYSTEM.md](https://github.com/frappe/crm/blob/988211bcd2e29d4860a0e69bc310c30d82386a6e/.pi/APPEND_SYSTEM.md)

该文件规定多方案决策、公共 API 兼容性、文档同步和测试命令，展示了大型项目如何使用 `.pi/APPEND_SYSTEM.md` 强化项目内行为。

### 专用 SYSTEM.md

[Agent engineering: Pi](https://roman.pt/posts/pi-dev-version/) 使用 `.pi/SYSTEM.md` 将 Pi 变成新闻抓取器，并关闭无关的内置工具和上下文文件。

[HazAT/word-fixer-app](https://github.com/HazAT/word-fixer-app) 使用独立 `SYSTEM.md` 将 Pi 变成只返回修正文本、不回答用户问题的文字校正引擎。

这两个实例说明 `SYSTEM.md` 适合完全替换角色，不适合承载普通编码偏好。

## 本仓库采用的结构

```text
pi-agent-config/
├── AGENTS.md                    # 本仓库自身的开发约定
└── global/
    ├── AGENTS.md                # 跨项目环境和开发约定
    └── APPEND_SYSTEM.md         # 跨项目行为规则
```

`setup.sh` 使用符号链接安装：

```text
global/AGENTS.md
  → ${PI_CODING_AGENT_DIR:-~/.pi/agent}/AGENTS.md

global/APPEND_SYSTEM.md
  → ${PI_CODING_AGENT_DIR:-~/.pi/agent}/APPEND_SYSTEM.md
```

根目录 `AGENTS.md` 只描述 `pi-agent-config` 仓库，不得安装为全局 `AGENTS.md`，否则其他项目会收到本仓库专属的扩展、测试和维护规则。

选择符号链接而不是复制，是为了让 Git 管理的源文件成为单一知识源；修改仓库文件后，Pi 在下次启动或执行 `/reload` 时直接读取新内容。
