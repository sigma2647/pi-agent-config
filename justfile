default:
    @just --list

# 同步 agent/agents 到全局 agents 目录
agents:
    @./setup.sh agents

# 注册 package，使 prompts/ 可被 Pi 发现
prompts:
    @./setup.sh prompts

# 安装所有扩展声明的 CLI 到 ~/.local/bin（扫描每个 */package.json 的 pi.cli 声明）
install:
    @./extensions/install.sh

# 列出可安装的扩展 CLI（不实际安装）
install-list:
    @./extensions/install.sh --list

# 移除 install 创建的所有 CLI 包装器
install-uninstall:
    @./extensions/install.sh --uninstall
