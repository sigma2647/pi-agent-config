default:
    @just --list

# 同步 agent/agents 到全局 agents 目录
agents:
    @./setup.sh agents

# 注册 package，使 prompts/ 可被 Pi 发现
prompts:
    @./setup.sh prompts

# 冒烟检查：验证所有 pi.extensions 可加载并校验 snippets 规范
check: check-extensions check-snippets

# 检查所有扩展是否能正常被 pi 加载
check-extensions:
    @node extensions/check.mjs

# 校验 prompt-snippets 规则文件是否符合 schema
check-snippets:
    @just -f extensions/prompt-snippets/justfile check


# 安装所有扩展声明的 CLI 到 ~/.local/bin（扫描每个 */package.json 的 pi.cli 声明）
install: check
    @./extensions/install.sh

# 列出可安装的扩展 CLI（不实际安装）
install-list:
    @./extensions/install.sh --list

# 移除 install 创建的所有 CLI 包装器
install-uninstall:
    @./extensions/install.sh --uninstall
