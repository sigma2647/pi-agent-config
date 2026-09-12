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

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The extension directory itself, so the fix hint works wherever the repo lives. */
const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Copy-pasteable fix for a missing runtime, shown both by the loader error and
 * by the readiness checks (so doctor/status say it before a recording is lost). */
export const SHERPA_INSTALL_HINT = `run: cd ${extensionDir} && npm install`;

/**
 * Is the `sherpa-onnx` package resolvable? Cheap on purpose: it only resolves
 * the path, it never loads the WASM module, so status/doctor can call it.
 */
export const sherpaRuntimeAvailable = (): boolean => {
  try {
    createRequire(import.meta.url).resolve("sherpa-onnx");
    return true;
  } catch {
    return false;
  }
};

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
    throw new Error(`sherpa-onnx is not installed (${detail}) — ${SHERPA_INSTALL_HINT}`);
  }
};
