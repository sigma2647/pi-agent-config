default:
    @just --list

# 同步 agent/agents 到全局 agents 目录
agents:
    @./setup.sh agents

# 注册 package，使 prompts/ 可被 Pi 发现
prompts:
    @./setup.sh prompts
