# auto-title

用一句纯中文短语总结当前对话，写进 pi 的**会话名**；在 herdr 里跑时，顺手把当前 tab 也改成这个名字。

解决的是「herdr 里每个 tab 只显示序号，认不出在干什么」。

## 行为

- 挂在 `agent_settled`（一轮彻底结束、pi 不会再自动续跑时触发）。`aborted` 的那轮跳过。
- **第一次生成**：会话里还没有本扩展的记录时，第一轮结束就生成标题，不用等 token 攒够。
- **之后刷新**：距上次生成累计新增 `refreshTokens` 个 token 才重新生成。计的是每轮 assistant 的 `usage.totalTokens` 之和（含输入与输出），不是上下文占用率。
- **保护手改**：当前会话名跟本扩展上次写的对不上，就认定是人手改的，不再自动更新。会话一开始就带名字（`pi -n 我的名字`）同样不碰。
- **纯中文**：模型输出里只要出现英文字母就重试一次；再不行就放弃，保持旧标题。宁可没有标题，也不要 `Promise allS` 这种中英混血。
- **静默失败**：模型不可用、对话为空、生成的标题没变化 —— 都直接返回，不动旧标题，不刷屏。

标题只写到会话名。herdr 的 workspace 名、pane 边框标签不经这里。

## tab 名

pi 把自己的名字写进终端标题（`π - 名字 - 目录`），但 herdr 不会拿它当 tab 名 —— 只有 `herdr tab rename` 能改。所以在 herdr 里跑时（面板里有 `HERDR_TAB_ID`），本扩展直接调 herdr CLI 改 tab 名：

| 时机 | 干的事 |
|---|---|
| 生成新名字后 | tab 名 = 新名字 |
| `session_start` | 补一次（恢复会话、herdr 重启后会把 tab 名退回序号） |
| `session_shutdown` | tab 名退回序号，免得 pi 退出后留个旧名字 |

只在 herdr 的默认数字、或本扩展上次写的名字上改；人手改过的 tab 名不碰。
不在 herdr 里跑（没有 `HERDR_TAB_ID`）就什么都不做。
## 为什么要 await 在 `agent_settled` 里

一开始写成 fire-and-forget（`void retitle(...)`），结果是：

```
生成失败：This extension ctx is stale after session replacement or reload.
```

handler 返回之后 `ctx` 就被守卫作废了，异步续做的工作拿不到可用的 `ctx`。所以模型调用必须在 handler 内 `await`。`agent_settled` 之后已经没有自动工作，阻塞它是安全的 —— 代价是每轮结束后有几秒在后台生成标题，界面没有提示。

## 命令

只有 `/retitle`：立刻强制重算一次，**会覆盖手改的名字**（明确要求了才这么做）。

不注册工具：它是给人用的，不是给模型调的，模型不需要自己改标题。

## 配置

读 `$PI_CODING_AGENT_DIR/extensions/auto-title.json`（默认 `~/.pi/agent/extensions/auto-title.json`）。文件不存在或字段缺失就用默认值；JSON 坏了也退回默认值，不让扩展加载失败。

```json
{
  "refreshTokens": 20000,
  "maxChars": 6,
  "excerptChars": 6000
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `refreshTokens` | `20000` | 距上次生成累计新增多少 token 后刷新。 |
| `maxChars` | `6` | 标题字数上限（中文按字算）。6 个字 = herdr tab 里 12 列，够用且不至于占满。 |
| `excerptChars` | `6000` | 喂给模型的对话摘录长度上限，超了就留头 20% + 尾 80%。 |

模型**跟随当前会话模型**（`ctx.model`），没有单独的模型配置项。

## 排查

设 `PI_AUTO_TITLE_DEBUG=1` 会往 stderr 打印每一步的判定，用来回答「为什么标题没变」：

```bash
PI_AUTO_TITLE_DEBUG=1 pi -p "随便问一句" 2>&1 | grep auto-title
```

典型输出：

```
[auto-title] 跳过：会话名 "我的手改名字" 不是本扩展写的（手改或 -n 起的）
[auto-title] 跳过：距上次生成只用了 17724 token（阈值 20000）
[auto-title] 已写入会话名：函数记忆作用域变量
```

## 已知限制

- 累计 token 用 `ctx.sessionManager.getEntries()` 统计，不区分分支。回退（rewind）到旧分支后，统计会把被放弃分支的 token 也算进去，可能提前触发一次刷新。
- 标题用当前会话模型生成，切到贵模型时这一步也跟着贵。
- 生成标题会阻塞 `agent_settled` 几秒。同一个 session 期间不会并发触发（`agent_settled` 一次一轮）。

## 依赖

- pi ≥ 1.1.0（用到 `agent_settled`、`pi.getSessionName()`、`ctx.modelRegistry.complete()`）。
- herdr 可选：装了就在 herdr 里把 tab 名也改掉，没装或不在 herdr 里跑就只写会话名。
- 同一个 tab 里跑两个 pi 会互相改名（按 tab 定位，不分 pane）。
