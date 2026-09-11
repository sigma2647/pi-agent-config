/**
 * Offline local provider.
 *
 * Two shapes of local model, one provider id:
 *   - `sense-voice-small` (offline): decode the finished recording in one pass.
 *   - `x-asr-480ms-zh-en-punct` (streaming): the interactive extension feeds
 *     audio while recording, so by the time the user stops, the text is already
 *     there. When a *file* is transcribed through a streaming model, this module
 *     replays the file through the same streaming session.
 *
 * Nothing here touches the network, so this provider works with no key and no
 * server.
 */

import { join } from "node:path";
import { localModelSpec, modelDir, type LocalModelSpec } from "./catalog.ts";
import { modelState } from "./model.ts";
import { createStreamingSession } from "./streaming.ts";
import { loadSherpa, type SherpaModule, type SherpaOfflineRecognizer, type SherpaOfflineStream, type SherpaWave } from "./sherpa.ts";
import { normalizeLanguage, type SttProvider } from "../providers/types.ts";

const recognizers = new Map<string, Promise<SherpaOfflineRecognizer>>();

/** Drop cached recognizers (used by tests and after a model re-download). */
export const resetRecognizerCache = (): void => recognizers.clear();

export const loadRecognizer = async (modelId: string, sherpa?: SherpaModule): Promise<SherpaOfflineRecognizer> => {
  const cached = recognizers.get(modelId);
  if (cached) return cached;

  const created = (async () => {
    const spec = offlineSpec(modelId);
    const state = modelState(modelId);
    if (!state.ready) throw new Error(`local model ${modelId} is not downloaded (missing ${state.missing.join(", ") || "files"})`);

    const runtime = sherpa ?? (await loadSherpa());
    const dir = modelDir(modelId);
    return runtime.createOfflineRecognizer({
      modelConfig: {
        senseVoice: {
          model: join(dir, spec.weights ?? "model.int8.onnx"),
          language: "",
          useInverseTextNormalization: 1,
        },
        tokens: join(dir, spec.tokens),
        numThreads: 1,
        provider: "cpu",
        debug: 0,
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
    });
  })();

  recognizers.set(modelId, created);
  created.catch(() => recognizers.delete(modelId));
  return created;
};

export const createLocalProvider = (
  id: string,
  config: { model: string; language?: string },
): SttProvider => ({
  id,
  label: localModelSpec(config.model)?.label ?? "Local model",
  kind: "local",
  async transcribe(input) {
    const spec = localModelSpec(config.model);
    if (!spec) throw new Error(`unknown local model: ${config.model}`);

    if (spec.kind === "streaming") {
      return { text: await transcribeStreaming(spec, input.audioPath, input.language ?? config.language) };
    }

    const [runtime, recognizer] = await Promise.all([loadSherpa(), loadRecognizer(config.model)]);

    let stream: SherpaOfflineStream | undefined;
    try {
      const wave = readWave(runtime, input.audioPath);
      stream = recognizer.createStream();
      stream.acceptWaveform(wave.sampleRate, wave.samples);
      recognizer.decode(stream);
      const text = readText(recognizer.getResult(stream));
      if (!text) return { text: "" };
      return { text: applyLanguageHint(text, normalizeLanguage(input.language ?? config.language)) };
    } finally {
      try {
        stream?.free();
      } catch {
        /* best effort */
      }
    }
  },
});

/** Replay a whole file through the streaming model: same text as live dictation. */
const transcribeStreaming = async (spec: LocalModelSpec, audioPath: string, language?: string): Promise<string> => {
  const runtime = await loadSherpa();
  const wave = readWave(runtime, audioPath);
  const session = await createStreamingSession(spec.id, wave.sampleRate);
  try {
    session.pushSamples(wave.samples);
    return applyLanguageHint(session.finish(), normalizeLanguage(language));
  } finally {
    session.free();
  }
};

export const readWave = (runtime: SherpaModule, audioPath: string): SherpaWave => {
  const wave = runtime.readWave(audioPath);
  if (!wave || !wave.samples || wave.samples.length === 0) throw new Error("the recording is empty");
  return wave;
};

const readText = (result: { text?: string } | undefined): string => (typeof result?.text === "string" ? result.text.trim() : "");

const offlineSpec = (modelId: string): LocalModelSpec => {
  const spec = localModelSpec(modelId);
  if (!spec) throw new Error(`unknown local model: ${modelId}`);
  if (spec.kind !== "offline") throw new Error(`local model ${modelId} is a streaming model — use createStreamingSession`);
  const state = modelState(modelId);
  if (!state.ready) throw new Error(`local model ${modelId} is not downloaded (missing ${state.missing.join(", ") || "files"})`);
  return spec;
};

/**
 * SenseVoice emits inline language/emotion tags such as `<|zh|><|NEUTRAL|>`
 * when inverse text normalization is off; strip anything left over.
 */
export const applyLanguageHint = (text: string, _language?: string): string => text.replace(/<\|[^|]*\|>/g, "").trim();
