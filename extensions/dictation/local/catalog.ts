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
  family?: "sense-voice" | "fire-red-asr-ctc" | "streaming-zipformer";
  /** Offline weights (`kind: "offline"`). */
  weights?: string;
  /** Streaming transducer parts (`kind: "streaming"`). */
  encoder?: string;
  decoder?: string;
  joiner?: string;
  /** Token table handed to sherpa-onnx. */
  tokens?: string;
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
    // Measured: 60 s decodes, 90 s aborts the WebAssembly module (memory), so
    // this is the highest round number known to work.
    maxSeconds: 60,
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

export const DEFAULT_LOCAL_MODEL = "sense-voice-small";

export const localModelSpec = (id: string): LocalModelSpec | undefined => LOCAL_MODELS[id];

export const modelsRoot = (): string => process.env.PI_DICTATION_MODELS_DIR?.trim() || join(homedir(), ".pi", "agent", "dictation-models");

export const modelDir = (id: string): string => join(modelsRoot(), id);

export const archiveCacheDir = (): string => join(modelsRoot(), ".cache");

export const archivePathFor = (spec: LocalModelSpec): string =>
  join(archiveCacheDir(), spec.url.split("/").pop() ?? `${spec.id}.tar.bz2`);

export const knownModelIds = (): string[] => Object.keys(LOCAL_MODELS);

export const isKnownModel = (id: string): boolean => Boolean(LOCAL_MODELS[id]);

export const isStreamingModel = (id: string): boolean => LOCAL_MODELS[id]?.kind === "streaming";
