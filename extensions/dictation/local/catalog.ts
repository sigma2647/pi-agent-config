/**
 * Local (offline) model catalog — the single place that knows which model
 * exists, which files it consists of, where it comes from, and how big it is.
 *
 * An entry here is data only. The code that turns those files into a recognizer
 * lives in the family named by `family`, one file per family in
 * `local/families/`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type LocalModelSpec = {
  id: string;
  /** Shown in status output and download prompts. */
  label: string;
  languages: string;
  /** Approximate download size (archive), used for progress and prompts. */
  sizeMb: number;
  url: string;
  /**
   * `offline` decodes a finished recording in one pass; `streaming` emits
   * partial text while the user is still speaking and never sees the whole
   * recording at once.
   */
  kind: "offline" | "streaming";
  /** Which sherpa-onnx family reads these files. Missing means `sense-voice`. */
  family?: "sense-voice" | "fire-red-asr-ctc" | "fun-asr-nano" | "streaming-zipformer";
  /** Offline weights (`kind: "offline"`). */
  weights?: string;
  /** Streaming transducer parts (`kind: "streaming"`). */
  encoder?: string;
  decoder?: string;
  joiner?: string;
  /** Token table handed to sherpa-onnx. */
  tokens?: string;
  /** Multi-file LLM-style families (`fun-asr-nano`): encoder adaptor, LLM decoder, embedding, and a tokenizer directory. */
  encoderAdaptor?: string;
  llm?: string;
  embedding?: string;
  tokenizer?: string;
  /**
   * Longest recording this model survives in the local runtime, in seconds.
   * Some families abort the whole WebAssembly module on longer input, so the
   * provider refuses the recording up front instead of dying mid-decode.
   * Missing means "no measured limit".
   */
  maxSeconds?: number;
};

export const LOCAL_MODELS: Record<string, LocalModelSpec> = {
  "sense-voice-small": {
    id: "sense-voice-small",
    label: "SenseVoice Small (int8)",
    languages: "中英日韩粤",
    sizeMb: 155,
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
    kind: "offline",
    family: "sense-voice",
    weights: "model.int8.onnx",
    tokens: "tokens.txt",
  },
  // The most accurate Chinese offline model here: the CTC branch of FireRedASR2,
  // which is also the faster of the two FireRedASR2 exports. No punctuation in
  // the output (unlike SenseVoice) and no live partial text.
  "fire-red-asr2-ctc-zh-en": {
    id: "fire-red-asr2-ctc-zh-en",
    label: "FireRedASR2-CTC (int8)",
    languages: "中文（含方言）",
    sizeMb: 496,
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25.tar.bz2",
    kind: "offline",
    family: "fire-red-asr-ctc",
    weights: "model.int8.onnx",
    tokens: "tokens.txt",
    // Measured on the native runtime: 83 s and 150 s decode fine, 272 s makes
    // ONNX Runtime throw an uncaught exception that kills the whole process.
    // The exact boundary is unknown, so this stays at the last round number
    // comfortably inside the safe zone.
    maxSeconds: 60,
  },
  // Small and whisper-aware: a SenseVoice encoder driving a Qwen3-0.6B decoder.
  // On the wEar Chinese whisper test set it is the best model in this catalog
  // (2.75% CER, against 15.41% for GLM-ASR-Nano and 16.33% for Whisper large-v3),
  // and it is the only one measured on whispered speech at all — see
  // docs/asr-model-selection.md §11.
  "fun-asr-nano": {
    id: "fun-asr-nano",
    label: "Fun-ASR-Nano (int8)",
    languages: "中英日",
    sizeMb: 802,
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2",
    kind: "offline",
    family: "fun-asr-nano",
    encoderAdaptor: "encoder_adaptor.int8.onnx",
    llm: "llm.int8.onnx",
    embedding: "embedding.int8.onnx",
    tokenizer: "Qwen3-0.6B",
    // This export was converted with `max_total_len=512` (audio frames + output
    // tokens in one budget), so long input does not crash — sherpa-onnx prints a
    // warning and returns an EMPTY transcript. Measured: the 20.76 s fixture
    // decodes in full, 25 s comes back truncated, 30 s and above come back empty.
    // Refusing up front turns that silent failure into a message. A re-export
    // with a larger `max_total_len` exists at
    // https://modelscope.cn/models/zengshuishui/FunASR-nano-onnx/ if needed.
    maxSeconds: 25,
  },
  // A streaming zipformer: the words appear while you speak, instead of after
  // you stop. Accurate on long speech, clearly weaker on a short utterance
  // (measured, see docs/asr-model-selection.md).
  "x-asr-480ms-zh-en-punct": {
    id: "x-asr-480ms-zh-en-punct",
    label: "X-ASR streaming 480ms (int8, 含标点)",
    languages: "中英",
    sizeMb: 127,
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2",
    kind: "streaming",
    family: "streaming-zipformer",
    encoder: "encoder.int8.onnx",
    decoder: "decoder.onnx",
    joiner: "joiner.int8.onnx",
    tokens: "tokens.txt",
  },
};

/**
 * The model a fresh config uses and the one `model download` fetches with no id.
 *
 * Fun-ASR-Nano over SenseVoice: it is the more accurate of the two on ordinary
 * Chinese (5.0% vs 7.9% CER on the hard fixture) and the only one that survives
 * whispered speech, which is why it is worth its costs — no punctuation, about
 * five times slower, and a 25 s ceiling on one recording (`maxSeconds` above).
 * SenseVoice stays installed as the fast, punctuated alternative.
 */
export const DEFAULT_LOCAL_MODEL = "fun-asr-nano";

export const localModelSpec = (id: string): LocalModelSpec | undefined => LOCAL_MODELS[id];

export const modelsRoot = (): string => process.env.PI_DICTATION_MODELS_DIR?.trim() || join(homedir(), ".pi", "agent", "dictation-models");

export const modelDir = (id: string): string => join(modelsRoot(), id);

export const archiveCacheDir = (): string => join(modelsRoot(), ".cache");

export const archivePathFor = (spec: LocalModelSpec): string =>
  join(archiveCacheDir(), spec.url.split("/").pop() ?? `${spec.id}.tar.bz2`);

export const knownModelIds = (): string[] => Object.keys(LOCAL_MODELS);

export const isKnownModel = (id: string): boolean => Boolean(LOCAL_MODELS[id]);

export const isStreamingModel = (id: string): boolean => LOCAL_MODELS[id]?.kind === "streaming";
