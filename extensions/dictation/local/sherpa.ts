/**
 * sherpa-onnx runtime loading, shared by the offline (whole-utterance) and the
 * streaming (live partial text) local models.
 *
 * The runtime is the **native** `sherpa-onnx-node` addon, not the WebAssembly
 * build. Both are the same sherpa-onnx version and produce the same text, but
 * the native build uses real threads: measured 4x faster decode on
 * Fun-ASR-Nano's 0.6B decoder (RTF 0.81 -> 0.21), and the WASM build cannot be
 * threaded at all — it prints "WASM does not support multi-threading" and
 * ignores `numThreads`.
 *
 * The addon's API differs from the WASM one in three ways, all absorbed here so
 * `provider.ts`, `streaming.ts` and the model families see one stable surface:
 *
 *   1. recognizers are classes (`new OfflineRecognizer(config)`) rather than
 *      factory functions;
 *   2. `stream.acceptWaveform` takes one `{samples, sampleRate}` object instead
 *      of two arguments;
 *   3. there is no `free()`. The addon is garbage-collected, so release is
 *      dropping the reference — the `free()` the callers already make is a
 *      no-op here rather than something they have to stop doing.
 *
 * The module is still loaded lazily and once per process, so CLI commands that
 * never transcribe (doctor, providers, keytest) do not pay for it.
 */

import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Native from "sherpa-onnx-node";

/** The extension directory itself, so the fix hint works wherever the repo lives. */
const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Copy-pasteable fix for a missing runtime, shown both by the loader error and
 * by the readiness checks (so doctor/status say it before a recording is lost). */
export const SHERPA_INSTALL_HINT = `run: cd ${extensionDir} && npm install`;

/**
 * Threads handed to every local model. Fun-ASR-Nano's decoder is the only one
 * that benefits much, and it stops improving past four (measured 4 threads:
 * RTF 0.21, 8 threads: 0.19), so this is a cap rather than "use every core" —
 * one core is also held back so recording and the UI keep responding.
 */
export const LOCAL_NUM_THREADS = Math.min(4, Math.max(1, availableParallelism() - 1));

/**
 * Can the addon actually load? Resolving the package path is not enough:
 * `sherpa-onnx-node` ships JavaScript only, and the native binary lives in a
 * separate `sherpa-onnx-<platform>-<arch>` package that npm installs only when
 * one exists for this machine. On any other platform resolution succeeds and the
 * *load* is what fails — so this loads it, which costs about 3 ms.
 */
export const sherpaRuntimeAvailable = (): boolean => {
  try {
    requireNative();
    return true;
  } catch {
    return false;
  }
};

export type SherpaWave = {
  sampleRate: number;
  samples: Float32Array;
};

export type SherpaOfflineStream = {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free(): void;
};

export type SherpaOfflineRecognizer = {
  createStream(): SherpaOfflineStream;
  decode(stream: SherpaOfflineStream): void;
  getResult(stream: SherpaOfflineStream): { text: string };
};

export type SherpaOnlineStream = SherpaOfflineStream & {
  /** Tell the recognizer that no more audio will arrive, so it can emit the tail. */
  inputFinished(): void;
};

export type SherpaOnlineRecognizer = {
  createStream(): SherpaOnlineStream;
  isReady(stream: SherpaOnlineStream): boolean;
  decode(stream: SherpaOnlineStream): void;
  getResult(stream: SherpaOnlineStream): { text: string };
};

/**
 * The runtime surface the rest of the extension programs against. It is the
 * subset of the WASM package's shape that we actually use, so the two builds
 * stay swappable.
 */
export type SherpaModule = {
  version: string;
  readWave(filename: string): SherpaWave;
  createOfflineRecognizer(config: unknown): SherpaOfflineRecognizer;
  createOnlineRecognizer(config: unknown): SherpaOnlineRecognizer;
};

/**
 * `createRequire`, not `import()`: the addon is CommonJS and its ESM named
 * exports are incomplete (`OfflineRecognizer` is only reachable through
 * `default`), so `import()` silently yields an object missing half the API.
 */
const requireNative = (): typeof Native => createRequire(import.meta.url)("sherpa-onnx-node") as typeof Native;

let cached: SherpaModule | undefined;

export const loadSherpa = async (): Promise<SherpaModule> => {
  if (cached) return cached;
  try {
    cached = adapt(requireNative());
    return cached;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`sherpa-onnx-node is not installed (${detail}) — ${SHERPA_INSTALL_HINT}`);
  }
};

/** Bridge the addon's class/object API into the two-argument offline shape the callers use. */
const adapt = (native: typeof Native): SherpaModule => ({
  version: native.version,

  readWave: (filename) => native.readWave(filename),

  createOfflineRecognizer: (config) => {
    const recognizer = new native.OfflineRecognizer(config);
    return {
      createStream: () => adaptStream(recognizer.createStream()),
      decode: (stream) => recognizer.decode(nativeStream(stream)),
      getResult: (stream) => recognizer.getResult(nativeStream(stream)),
    };
  },

  createOnlineRecognizer: (config) => {
    const recognizer = new native.OnlineRecognizer(config);
    return {
      createStream: () => adaptStream(recognizer.createStream()),
      isReady: (stream) => recognizer.isReady(nativeStream<Native.NativeOnlineStream>(stream)),
      decode: (stream) => recognizer.decode(nativeStream<Native.NativeOnlineStream>(stream)),
      getResult: (stream) => recognizer.getResult(nativeStream<Native.NativeOnlineStream>(stream)),
    };
  },
});

type NativeStream = Native.NativeOfflineStream & Partial<Pick<Native.NativeOnlineStream, "inputFinished">>;

/** Where the adapted stream keeps the addon stream it wraps, so the recognizer
 * methods above can hand it back. A symbol, not a field, keeps it out of the
 * surface the rest of the extension sees. */
const NATIVE_STREAM = Symbol("sherpa native stream");

type AdaptedStream = SherpaOnlineStream & { [NATIVE_STREAM]: NativeStream };

const adaptStream = (stream: NativeStream): AdaptedStream => ({
  [NATIVE_STREAM]: stream,
  acceptWaveform: (sampleRate, samples) => stream.acceptWaveform({ sampleRate, samples }),
  inputFinished: () => stream.inputFinished?.(),
  // The addon has no explicit release; dropping the reference is the release.
  free: () => {},
});

const nativeStream = <S extends NativeStream>(stream: SherpaOfflineStream): S => {
  const native = (stream as Partial<AdaptedStream>)[NATIVE_STREAM];
  if (!native) throw new Error("this stream was not created by the local runtime");
  return native as S;
};
