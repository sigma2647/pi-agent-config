# 测试音频

用于横向比较本地模型在**难中文**上的表现。数据量很小，但比短句更能拉开差距。

## `raokouling.wav`

- 来源：Qwen3-ASR 官方测试集，随 sherpa-onnx 的
  `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2` 发布
  （原始出处：<https://qwen.ai/blog?id=qwen3asr>，Qwen 官方内部 TongueTwister 基准用音频）。
- 格式：44.1 kHz 单声道，20.76 秒。
- 标准答案（140 字，已去掉标点后计分）：

  ```
  广西壮族自治区爱吃红鲤鱼与绿鲤鱼与驴的出租车司机，拉着苗族土家族自治州爱喝自制的刘奶奶榴莲牛奶的骨质疏松症患者，遇见别着喇叭的哑巴，打败咬死山前四十四棵紫色柿子树的四十四只石狮子之后，碰到年年恋牛娘的牛郎，念着灰黑灰化肥发黑会挥发，走出香港官方网站设置组，到广西壮族自治区首府南宁市民族医院就医。
  ```

## 怎么用

```bash
cd extensions/dictation

# 本地模型：直接转写，然后和上面的标准答案对比
PI_DICTATION_CONFIG=/tmp/cfg.json ./dev.ts transcribe test/fixtures/raokouling.wav

# 本机服务（Qwen3-ASR 等）：config 里指到 127.0.0.1 的 OpenAI 兼容端点
./scripts/qwen3-asr-server.py --model Qwen/Qwen3-ASR-1.7B
```

对比结果记在 `docs/asr-model-selection.md` 的第 11 节。计分时：去掉标点与空格、把阿拉伯数字换算成中文数字，再算字错率（CER）。
