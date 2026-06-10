# Testing pi extensions headlessly (tool-routing eval)

> 固化自 2026-06-10 的调试。用途:验证某个 extension 的 `description` / `promptGuidelines`
> 字段**本身**能否让 pi(LLM agent)做出预期的工具路由(何时用 `web_search` /
> `web_fetch` / `opencli` / `gh` …),而不是被全局 `AGENTS.md` 或 skill 间接教会。

## pi 的 headless 接口

`pi` 支持非交互运行,输出可解析的 NDJSON 事件流:

```bash
pi --print --mode json --no-session \
   --provider deepseek --model deepseek-v4-flash --thinking off \
   "<prompt>"
```

- `--print` / `-p` — 处理完 prompt 即退出(非交互)。
- `--mode json` — 输出 NDJSON 事件流(每行一个 JSON 事件)。
- `--no-session` — ephemeral,不落 session 文件、不污染历史。
- provider:本机只有 `DEEPSEEK_API_KEY`,故用 `deepseek` + `deepseek-v4-flash`(快)。`pi --list-models deepseek` 看可用模型。

## 隔离实验:测「字段本身」而非全局上下文

要回答「是 extension 的字段在教 pi,还是全局 AGENTS.md / skill 在教」,必须剥掉后两者。
关键变量是 **`--no-context-files`** 和 **`--no-skills`**:

| 条件 | 命令增量 | 含义 |
|---|---|---|
| **ISO**(隔离) | `--no-extensions -e $A -e $B --no-context-files --no-skills` | 只有显式加载的 extension 的字段在影响 agent;全局 AGENTS.md/CLAUDE.md 与所有 skill 都关掉 |
| **FULL**(真实) | `--no-extensions -e $A -e $B` | 同上但 AGENTS.md + skill 都在 |

只切换 `--no-context-files --no-skills` 这一个变量,其余恒定。`--no-extensions -e <path>`
表示「关掉自动发现,只加载这几个显式路径」,保证两条件下 extension 加载完全一致。

`$A`/`$B` 用**绝对路径**(`/home/lawrence/pi-agent-config/extensions/web-fetch/index.ts` 等)。

## 从 NDJSON 提取工具调用

流式会对同一个 toolCall id 吐出很多部分命令;取每个 id 下**最长/最完整**的那条:

```bash
node --input-type=module -e '
import fs from "node:fs";
const ls = fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
const byId = {};
for (const l of ls) { let e; try { e = JSON.parse(l) } catch { continue }
  const m = e.message;
  if (m && m.role === "assistant" && Array.isArray(m.content))
    for (const c of m.content) if (c.type === "toolCall") {
      const cmd = c.arguments?.command ?? JSON.stringify(c.arguments ?? {});
      if (!byId[c.id] || cmd.length > byId[c.id].cmd.length) byId[c.id] = { name: c.name, cmd };
    }
}
for (const k of Object.keys(byId)) console.log(byId[k].name, "|", byId[k].cmd.slice(0,160));
' /path/to/output.ndjson
```

把每次跑的「首个实质工具动作」分类为:`opencli` / `gh` / `curl api.github.com`(反模式) /
`web_fetch` / `web_search` / 其他。忽略 `echo`/`ls`/`which` 探路命令。

## 已验证结论(2026-06-10)

- **opencli 路由 = extension 自己教的(置信度高)**。ISO 条件(AGENTS.md + opencli-skill 都关)下,
  prompt「搜 B 站 Rust 异步视频」→ pi 实际跑出
  `opencli bilibili search "Rust 异步编程" -f json` 和 `opencli list | grep -i bilib`——
  逐字命中 `web-search/index.ts` 的 `promptGuidelines`。该条件下 opencli 知识唯一来源就是
  extension,且这种精确语法/习惯用法训练知识给不出 → 是字段教的。
- **gh 路由不在任何 extension**。`grep -n "gh" extensions/web-{fetch,search}/index.ts` 证实;
  gh-vs-curl 规则只在全局 AGENTS.md。2026-06-10 起 `web-fetch/index.ts` 的 promptGuidelines
  补了一条简短 gh 指引(commits/releases/activity → `gh api`)。
- 据 [记忆 pi-extension-prompt-surfaces]:真正驱动路由的是 `promptGuidelines`(逐字进 system
  prompt 的 Guidelines 段),`description` 只驱动工具选择。要教「何时/如何用」就写 promptGuidelines。

## ⚠️ Known issue:`pi -e <extension>` 启动期挂死(未解决)

2026-06-10 复现:带 `-e <任意本仓 extension>` 时,pi 在**启动阶段**挂死——
`timeout` 110s 后 **0 字节输出**,连第一个 `session` 事件都没 emit(124 退出)。

**已排除**(逐项实测):
- 不是 provider/网络到 LLM:**裸 `pi --print 'say hi'` 正常**吐 session/text/pong。
- 不是代理:`HTTPS_PROXY= HTTP_PROXY= pi -e ...` 仍挂(代理 `192.168.1.153:7890` 对裸 LLM 调用是通的)。
- 不是僵尸进程 / 锁 / 负载:无 stray pi 进程、`~/.pi` 无 `.lock`/`.sock`、load < 1。
- 不是 prompt、不是 `--thinking off`、单个 `-e` 也挂、trivial prompt 也挂。

**诡异点**:本会话**首次** `-e $A -e $B` 调用成功(吐了 84KB、含 opencli 命令),之后同样命令稳定挂死。
疑似首次成功后进入某种卡死态(extension 加载 / strip-types 编译缓存?),根因未定。

**复现 & 下一步**:
```bash
# 裸命令(对照,通):
pi --print --mode json --no-session --provider deepseek --model deepseek-v4-flash "say pong"
# 带 -e(挂):
pi --print --mode json --no-session --provider deepseek --model deepseek-v4-flash \
   --no-extensions -e <abs-path-to-index.ts> "say pong"
# 看卡在哪一步:
pi --debug -e <abs-path-to-index.ts> "say pong"   # 观察 stderr 最后停在哪
```
若 `-e` 在本机持续挂,这个隔离实验做不了——换机器(jy-gzz-arch)或修 pi extension 加载后再跑。
