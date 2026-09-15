/**
 * The local backend: sherpa-onnx running in this process — no network, no key,
 * no per-minute cost. Its models come from `local/catalog.ts` and its model
 * families from `local/families/`.
 */

import type { LocalProviderConfig } from "../config.ts";
import { localModelSpec } from "./catalog.ts";
import { modelState } from "./model.ts";
import { createLocalProvider } from "./provider.ts";
import { SHERPA_INSTALL_HINT, sherpaRuntimeAvailable } from "./sherpa.ts";
import type { Backend } from "../providers/types.ts";

export const localBackend: Backend<LocalProviderConfig> = {
  create: (id, config) => createLocalProvider(id, config),
  status: (id, config) => {
    const spec = localModelSpec(config.model);
    if (!spec) {
      return { id, kind: "local", label: "local", ready: false, detail: `unknown local model "${config.model}" (run /dictation model to list)` };
    }
    const state = modelState(config.model);
    // Downloaded files are not enough: without the sherpa-onnx package the model
    // cannot run, and "ready" would only fail after the user finished speaking.
    if (state.ready && !sherpaRuntimeAvailable()) {
      return {
        id,
        kind: "local",
        label: `local · ${spec.label}`,
        ready: false,
        detail: `model ready (${state.dir}) but the sherpa-onnx runtime is missing — ${SHERPA_INSTALL_HINT}`,
      };
    }
    return {
      id,
      kind: "local",
      label: `local · ${spec.label}`,
      ready: state.ready,
      detail: state.ready ? `model ready (${state.dir})` : `model not downloaded: /dictation model download (≈${state.sizeMb} MB)`,
    };
  },
};
