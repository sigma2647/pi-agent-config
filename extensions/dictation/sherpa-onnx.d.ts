/**
 * Minimal type surface for the `sherpa-onnx` WASM package (JavaScript only
 * upstream, so no types ship with it). One declaration file for every model
 * type this extension uses: offline (SenseVoice) and streaming (zipformer
 * transducer). Keep it in step with `local/sherpa.ts`, which loads the module.
 */
declare module "sherpa-onnx" {
  export const version: string;

  export type SherpaOfflineStream = {
    acceptWaveform(sampleRate: number, samples: Float32Array): void;
    free(): void;
  };

  export type SherpaOfflineRecognizer = {
    createStream(): SherpaOfflineStream;
    decode(stream: SherpaOfflineStream): void;
    getResult(stream: SherpaOfflineStream): { text: string };
    free(): void;
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
    free(): void;
  };

  export type SherpaWave = {
    sampleRate: number;
    samples: Float32Array;
  };

  export function createOfflineRecognizer(config: unknown): SherpaOfflineRecognizer;
  export function createOnlineRecognizer(config: unknown): SherpaOnlineRecognizer;
  export function readWave(filename: string): SherpaWave;
}
