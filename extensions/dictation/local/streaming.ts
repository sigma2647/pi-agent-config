/**
 * Streaming (online) local model: partial text while the user is still speaking.
 *
 * The recognizer is created once per model and cached — loading it costs about
 * a second, the same as the offline model. Every recording gets a fresh stream.
 *
 * Decoding is synchronous and single-threaded (the WASM build has no threads),
 * so this module never decodes on its own: the caller pushes audio and decides
 * when to `step()` (the extension does it from its UI ticker). One `step()` on
 * 0.1 s of audio costs about 10 ms, which is why the caller can run it inside
 * the render loop.
 */

import { join } from "node:path";
import { localModelSpec, modelDir, type LocalModelSpec } from "./catalog.ts";
import { modelState } from "./model.ts";
import { loadSherpa, type SherpaModule, type SherpaOnlineRecognizer, type SherpaOnlineStream } from "./sherpa.ts";

export type StreamingSession = {
  /** Queue raw PCM16LE bytes, exactly as the recorder produces them. */
  push(pcm: Buffer): void;
  /** Queue decoded samples (used when the audio comes from a WAV file). */
  pushSamples(samples: Float32Array): void;
  /** Decode everything queued so far and return the current transcript. */
  step(): string;
  /** Flush the tail of the audio and return the final transcript. */
  finish(): string;
  /** Samples queued but not decoded yet (diagnostics and tests). */
  pendingSamples(): number;
  /** Release the stream. Safe to call twice. */
  free(): void;
};

const recognizers = new Map<string, Promise<SherpaOnlineRecognizer>>();

/** Silence appended before the final decode, so the last word is not dropped. */
const TAIL_PAD_SECONDS = 1;

/** Drop cached recognizers (used by tests and after a model re-download). */
export const resetStreamingCache = (): void => recognizers.clear();

export const loadStreamingRecognizer = async (modelId: string, sherpa?: SherpaModule): Promise<SherpaOnlineRecognizer> => {
  const cached = recognizers.get(modelId);
  if (cached) return cached;

  const created = (async () => {
    const spec = streamingSpec(modelId);
    const dir = modelDir(modelId);
    const runtime = sherpa ?? (await loadSherpa());
    return runtime.createOnlineRecognizer({
      modelConfig: {
        transducer: {
          encoder: join(dir, spec.encoder!),
          decoder: join(dir, spec.decoder!),
          joiner: join(dir, spec.joiner!),
        },
        tokens: join(dir, spec.tokens),
        numThreads: 1,
        provider: "cpu",
        debug: 0,
      },
      featConfig: { sampleRate: 16000, featureDim: 80 },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
      // No endpointing: a pause in the middle of a dictation must not restart
      // the stream, or the user loses the words they already spoke. The stream
      // keeps the whole hypothesis instead of the whole audio, so memory stays
      // flat for long recordings.
      enableEndpoint: 0,
    });
  })();

  recognizers.set(modelId, created);
  created.catch(() => recognizers.delete(modelId));
  return created;
};

/**
 * One recording. `sampleRate` is the rate the recorder captured at; sherpa-onnx
 * resamples when it differs from the model's expected 16 kHz.
 */
export const createStreamingSession = async (modelId: string, sampleRate: number): Promise<StreamingSession> => {
  const recognizer = await loadStreamingRecognizer(modelId);
  const stream: SherpaOnlineStream = recognizer.createStream();

  let queued: Float32Array[] = [];
  let queuedSamples = 0;
  let halfSample: Buffer | undefined;
  let text = "";
  let released = false;

  const decodeAvailable = (): void => {
    if (queuedSamples > 0) {
      stream.acceptWaveform(sampleRate, joinChunks(queued, queuedSamples));
      queued = [];
      queuedSamples = 0;
    }
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    text = readText(recognizer.getResult(stream));
  };

  const pushSamples = (samples: Float32Array): void => {
    if (released || samples.length === 0) return;
    queued.push(samples);
    queuedSamples += samples.length;
  };

  return {
    pushSamples,
    push(pcm: Buffer): void {
      if (released || pcm.length === 0) return;
      const { samples, rest } = pcmToSamples(halfSample ? Buffer.concat([halfSample, pcm]) : pcm);
      halfSample = rest;
      pushSamples(samples);
    },
    step(): string {
      if (released) return text;
      decodeAvailable();
      return text;
    },
    finish(): string {
      if (released) return text;
      // The last word needs audio after it to be emitted: without this padding
      // a dictation ends one word early (measured: 0.3 s is not enough for
      // Chinese, 1 s always is, and it costs about 0.1 s to decode).
      pushSamples(new Float32Array(Math.round(sampleRate * TAIL_PAD_SECONDS)));
      decodeAvailable();
      stream.inputFinished();
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      text = readText(recognizer.getResult(stream));
      return text;
    },
    pendingSamples(): number {
      return queuedSamples + (halfSample ? 1 : 0);
    },
    free(): void {
      if (released) return;
      released = true;
      queued = [];
      queuedSamples = 0;
      halfSample = undefined;
      try {
        stream.free();
      } catch {
        /* best effort */
      }
    },
  };
};

const streamingSpec = (modelId: string): LocalModelSpec => {
  const spec = localModelSpec(modelId);
  if (!spec) throw new Error(`unknown local model: ${modelId}`);
  if (spec.kind !== "streaming") throw new Error(`local model ${modelId} is not a streaming model`);
  if (!spec.encoder || !spec.decoder || !spec.joiner) throw new Error(`local model ${modelId} has no streaming model files`);
  const state = modelState(modelId);
  if (!state.ready) throw new Error(`local model ${modelId} is not downloaded (missing ${state.missing.join(", ") || "files"})`);
  return spec;
};

/** PCM16LE → Float32 in [-1, 1]. An odd trailing byte waits for the next chunk. */
export const pcmToSamples = (pcm: Buffer): { samples: Float32Array; rest?: Buffer } => {
  const usable = pcm.length - (pcm.length % 2);
  const samples = new Float32Array(usable / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = pcm.readInt16LE(index * 2) / 32768;
  return usable === pcm.length ? { samples } : { samples, rest: pcm.subarray(usable) };
};

const joinChunks = (chunks: Float32Array[], total: number): Float32Array => {
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
};

const readText = (result: { text?: string } | undefined): string => (typeof result?.text === "string" ? result.text.trim() : "");
