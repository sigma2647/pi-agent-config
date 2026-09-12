/**
 * Local (offline) model catalog — the single place that knows which files a
 * model needs, where it comes from, and how big it is.
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
  /** Files that must exist in the model directory for it to count as ready. */
  files: string[];
  /** Token table handed to sherpa-onnx. */
  tokens: string;
  /**
   * `offline` decodes a finished recording in one pass; `streaming` emits
   * partial text while the user is still speaking and never sees the whole
   * recording at once.
   */
  kind: "offline" | "streaming";
  /** Offline weights (`kind: "offline"`). */
  weights?: string;
  /** Streaming transducer parts (`kind: "streaming"`). */
  encoder?: string;
  decoder?: string;
  joiner?: string;
};

export const LOCAL_MODELS: Record<string, LocalModelSpec> = {
  "sense-voice-small": {
    id: "sense-voice-small",
    label: "SenseVoice Small (int8)",
    languages: "中文 / English / 日本語 / 한국어 / 粤语",
    sizeMb: 155,
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
    files: ["model.int8.onnx", "tokens.txt"],
    kind: "offline",
    weights: "model.int8.onnx",
    tokens: "tokens.txt",
  },
  // A streaming zipformer: the words appear while you speak, instead of after
  // you stop. Slightly less accurate than SenseVoice on the same audio, but it
  // is the only local option that can show a partial transcript.
  "x-asr-480ms-zh-en-punct": {
    id: "x-asr-480ms-zh-en-punct",
    label: "X-ASR streaming 480ms (int8, 含标点)",
    languages: "中文 / English",
    sizeMb: 127,
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2",
    files: ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"],
    kind: "streaming",
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
