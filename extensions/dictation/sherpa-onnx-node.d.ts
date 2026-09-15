/**
 * Minimal type surface for the `sherpa-onnx-node` native addon (JavaScript only
 * upstream, so no types ship with it). One declaration file for every model
 * type this extension uses: offline (SenseVoice, FireRedASR2, Fun-ASR-Nano) and
 * streaming (zipformer transducer).
 *
 * Only what `local/sherpa.ts` touches is declared. That file adapts this
 * surface into the shape the rest of the extension programs against, so this
 * file is the one place that has to change if upstream renames something.
 */

declare module "sherpa-onnx-node" {
  export const version: string;
  export const onnxruntimeVersion: string;

  /** Waveform as the native addon returns and accepts it. */
  export type WaveObject = {
    samples: Float32Array;
    sampleRate: number;
  };

  export type NativeOfflineStream = {
    /** Unlike the WASM build, this takes one object rather than two arguments. */
    acceptWaveform(wave: WaveObject): void;
  };

  export type NativeOfflineResult = {
    text: string;
  };

  export class OfflineRecognizer {
    constructor(config: unknown);
    createStream(): NativeOfflineStream;
    decode(stream: NativeOfflineStream): void;
    getResult(stream: NativeOfflineStream): NativeOfflineResult;
  }

  export type NativeOnlineStream = NativeOfflineStream & {
    /** Tell the recognizer that no more audio will arrive, so it can emit the tail. */
    inputFinished(): void;
  };

  export class OnlineRecognizer {
    constructor(config: unknown);
    createStream(): NativeOnlineStream;
    isReady(stream: NativeOnlineStream): boolean;
    decode(stream: NativeOnlineStream): void;
    getResult(stream: NativeOnlineStream): NativeOfflineResult;
  }

  export function readWave(filename: string): WaveObject;
}
