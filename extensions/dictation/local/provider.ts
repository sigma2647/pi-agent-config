/**
 * Offline local provider.
 *
 * Two shapes of local model, one provider id, and one family module per shape:
 *   - offline (SenseVoice, FireRedASR2-CTC): decode the finished recording in
 *     one pass.
 *   - streaming (x-asr zipformer): the interactive extension feeds audio while
 *     recording, so by the time the user stops, the text is already there. When
 *     a *file* is transcribed through a streaming model, this module replays
 *     the file through the same streaming session.
 *
 * Nothing here touches the network, so this provider works with no key and no
 * server.
 */

import { localModelSpec, modelDir, type LocalModelSpec } from "./catalog.ts";
import { localFamily } from "./families/index.ts";
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
    const family = localFamily(spec);
    const modelConfig = family.offline?.(spec, dir);
    if (!modelConfig) throw new Error(`local model ${modelId} cannot decode a finished recording (family "${family.id}" only streams)`);
    return runtime.createOfflineRecognizer({
      modelConfig: {
        ...modelConfig,
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
      assertWithinLimit(spec, wave);
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

/**
 * Some families abort the whole WebAssembly runtime on long input (FireRedASR2
 * CTC above about 90 s, measured). Refusing up front keeps the process alive and
 * tells the user what to do instead of losing the transcription to a crash.
 */
const assertWithinLimit = (spec: LocalModelSpec, wave: SherpaWave): void => {
  const limit = spec.maxSeconds;
  if (!limit) return;
  const seconds = wave.samples.length / wave.sampleRate;
  if (seconds <= limit) return;
  throw new Error(
    `${spec.label} cannot decode more than ${limit}s in one piece (this recording is ${seconds.toFixed(0)}s) — record a shorter clip, or switch model with /dictation model use`,
  );
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
