/**
 * sherpa-onnx runtime loading, shared by the offline (whole-utterance) and the
 * streaming (live partial text) local models.
 *
 * The WASM module is loaded lazily and once per process: it costs about half a
 * second and every model here uses the same instance. Keeping the import
 * dynamic means the CLI commands that never transcribe (doctor, providers,
 * keytest) do not pay for it.
 *
 * The type surface lives in `sherpa-onnx.d.ts` at the extension root — one
 * place that describes what the upstream package offers.
 */

export type {
  SherpaOfflineRecognizer,
  SherpaOfflineStream,
  SherpaOnlineRecognizer,
  SherpaOnlineStream,
  SherpaWave,
} from "sherpa-onnx";

export type SherpaModule = typeof import("sherpa-onnx");

export const loadSherpa = async (): Promise<SherpaModule> => {
  try {
    return await import("sherpa-onnx");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`sherpa-onnx is not installed (${detail}) — run: cd ~/pi-agent-config/extensions/dictation && npm install`);
  }
};
