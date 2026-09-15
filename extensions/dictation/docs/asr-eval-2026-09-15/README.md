# 耳语识别实测原始数据（2026-09-15）

`docs/asr-model-selection.md` 第 11 节的每一个数字都出自这里的文件，可用
`scripts/asr-cer.py` 复算。测量机器：28 核 CPU / 125 GB 内存 / GTX 960（用不上），
全部走 pi-dictation 自己的转写路径（`sherpa-onnx-node` 1.13.8 原生插件，`qwen3-asr` 除外）。

这组是 2026-09-15 换原生运行时**之后**重新生成的。换之前用 WASM 运行时跑过同一批，
结果只差一两个字（线程数不同 → 浮点归约顺序不同），`fun-asr-nano` 逐字输出完全一样。

## 三份音频

| 样本 | 是什么 | 字数 | 是不是耳语 |
|---|---|---|---|
| `reference.raokouling.txt` | `test/fixtures/raokouling.wav`，难中文绕口令，正常说话 | 140 | 否 |
| `reference.whisper-1.txt` | 对着麦克风小声说的中文短句（5.9 秒） | 20 | **是** |
| `reference.whisper-2.txt` | 同一条件下的长句（11.0 秒） | 43 | **是** |

耳语那两段的声学特征（`scripts/whisper-probe.py`）：浊音帧占比 3.3% / 14.8%，
300 Hz 以下能量 13.8% / 11.1%，谱质心 1250 / 1235 Hz。正常语音的对照值是
35% / 33–76% / 252–570 Hz。

原始录音在 `~/.local/share/org.gnome.SoundRecorder/`，不在仓库里。

## 五个模型

`<模型 id>.<样本>.txt` 是每个模型的原始输出，未做任何修改。

| 模型 | 怎么跑的 |
|---|---|
| `fun-asr-nano` | 扩展进程内（原生插件），本目录新增的模型 |
| `qwen3-asr` | `scripts/qwen3-asr-server.py` 起本机服务，走 `qwen-local` provider |
| `x-asr-480ms-zh-en-punct` | 扩展进程内（原生插件），流式 |
| `sense-voice-small` | 扩展进程内（原生插件），默认模型 |
| `fire-red-asr2-ctc-zh-en` | 扩展进程内（原生插件） |

## 复算

```bash
cd extensions/dictation
for s in raokouling whisper-1 whisper-2; do
  python3 scripts/asr-cer.py docs/asr-eval-2026-09-15/reference.$s.txt docs/asr-eval-2026-09-15/*.$s.txt
done
```

`scripts/asr-cer.py` 的规则：去掉标点与空白，阿拉伯数字换成中文数字，再算字错率。
`reference.raokouling` 自己不参与打分（它是参考本身，CER 必然是 0）。
