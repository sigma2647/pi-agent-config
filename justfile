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


# --- Qwen3-ASR 听写后端（systemd 用户服务 qwen3-asr.service）---
# pi-dictation 的 "qwen-local" provider 指向 http://127.0.0.1:8123。
# 服务已 enable，登录/开机后自动启动；下面三条用于手动控制。

# 启动听写后端，并等到模型加载完成（本机约 60 秒）
asr-start:
    @systemctl --user start qwen3-asr.service
    @for i in $(seq 1 40); do \
        curl -sf -m 2 http://127.0.0.1:8123/health 2>/dev/null | grep -q '"ok"' && { \
            echo "qwen3-asr 就绪 — http://127.0.0.1:8123/v1/audio/transcriptions"; exit 0; }; \
        sleep 3; \
    done; \
    echo "启动超时（120 秒），看 just asr-logs" >&2; exit 1

# 停止听写后端，释放约 8 GB 内存
asr-stop:
    @systemctl --user stop qwen3-asr.service
    @echo "qwen3-asr 已停止"

# 查看听写后端状态与健康检查
asr-status:
    @systemctl --user status qwen3-asr.service --no-pager | head -8
    @printf 'health: '; curl -s -m 2 http://127.0.0.1:8123/health || echo "无响应"

# 查看听写后端日志（最近 50 行）
asr-logs:
    @tail -n 50 /home/lawrence/.local/state/qwen3-asr/server.log
