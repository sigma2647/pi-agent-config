/**
 * Provider registry: one place that answers three questions.
 *   1. which providers are configured,
 *   2. which of them can actually run right now,
 *   3. which one `provider: "auto"` picks (first ready in AUTO_PROVIDER_ORDER).
 *
 * Adding a vendor = write `providers/<name>.ts` + one case in `createProvider`.
 */

import { AUTO_PROVIDER_ORDER, resolveApiKey, type ProviderConfig, type DictationConfig } from "../config.ts";
import { localModelSpec } from "../local/catalog.ts";
import { modelState } from "../local/model.ts";
import { SHERPA_INSTALL_HINT, sherpaRuntimeAvailable } from "../local/sherpa.ts";
import { createLocalProvider } from "../local/provider.ts";
import { createDeepgramProvider } from "./deepgram.ts";
import { endpointNeedsAuth } from "./endpoint.ts";
import { createOpenAiCompatibleProvider } from "./openai-compatible.ts";
import type { SttProvider } from "./types.ts";

export type ProviderStatus = {
  id: string;
  kind: "local" | "cloud";
  label: string;
  ready: boolean;
  detail: string;
};

export const providerKind = (config: ProviderConfig): "local" | "cloud" => (config.type === "local" ? "local" : "cloud");

export const providerStatus = (id: string, config: ProviderConfig, env: NodeJS.ProcessEnv = process.env): ProviderStatus => {
  const kind = providerKind(config);

  if (config.type === "local") {
    const spec = localModelSpec(config.model);
    if (!spec) {
      return { id, kind, label: "local", ready: false, detail: `unknown local model "${config.model}" (run /dictation model to list)` };
    }
    const state = modelState(config.model);
    // Downloaded files are not enough: without the sherpa-onnx package the model
    // cannot run, and "ready" would only fail after the user finished speaking.
    if (state.ready && !sherpaRuntimeAvailable()) {
      return {
        id,
        kind,
        label: `local · ${spec.label}`,
        ready: false,
        detail: `model ready (${state.dir}) but the sherpa-onnx runtime is missing — ${SHERPA_INSTALL_HINT}`,
      };
    }
    return {
      id,
      kind,
      label: `local · ${spec.label}`,
      ready: state.ready,
      detail: state.ready ? `model ready (${state.dir})` : `model not downloaded: /dictation model download (≈${state.sizeMb} MB)`,
    };
  }

  if (config.type === "openai-compatible") {
    let local = false;
    try {
      local = !endpointNeedsAuth(config.endpoint);
    } catch (error) {
      return { id, kind, label: "openai-compatible", ready: false, detail: error instanceof Error ? error.message : String(error) };
    }
    if (local) {
      return { id, kind, label: `openai-compatible · ${config.model}`, ready: true, detail: `local endpoint ${config.endpoint} (no key needed)` };
    }
    const { key, source } = resolveApiKey(config, env);
    return {
      id,
      kind,
      label: `openai-compatible · ${config.model}`,
      ready: Boolean(key),
      detail: key ? `${config.endpoint} (key from ${source})` : `${config.endpoint} — set ${config.apiKeyEnv || "apiKey"}`,
    };
  }

  const { key, source } = resolveApiKey(config, env);
  return {
    id,
    kind,
    label: `deepgram · ${config.model}`,
    ready: Boolean(key),
    detail: key ? `${config.endpoint} (key from ${source})` : `${config.endpoint} — set ${config.apiKeyEnv || "apiKey"}`,
  };
};

export const providerStatuses = (config: DictationConfig, env: NodeJS.ProcessEnv = process.env): ProviderStatus[] =>
  Object.entries(config.providers).map(([id, provider]) => providerStatus(id, provider, env));

export type ResolvedProvider = {
  id: string;
  config: ProviderConfig;
  status: ProviderStatus;
  reason: string;
};

/** Pick the provider to use: the configured one, or the first ready one in AUTO_PROVIDER_ORDER. */
export const resolveProvider = (config: DictationConfig, env: NodeJS.ProcessEnv = process.env): ResolvedProvider | undefined => {
  const statuses = new Map(providerStatuses(config, env).map((status) => [status.id, status]));

  if (config.provider !== "auto") {
    const providerConfig = config.providers[config.provider];
    const status = statuses.get(config.provider);
    // An explicitly chosen provider is never silently swapped, but it must be ready:
    // otherwise the caller gets a clear "nothing is ready" error with doctor details.
    if (!providerConfig || !status?.ready) return undefined;
    return { id: config.provider, config: providerConfig, status, reason: `configured provider "${config.provider}"` };
  }

  for (const id of AUTO_PROVIDER_ORDER) {
    const providerConfig = config.providers[id];
    const status = statuses.get(id);
    if (providerConfig && status?.ready) {
      return { id, config: providerConfig, status, reason: `auto: first ready provider in ${AUTO_PROVIDER_ORDER.join(" → ")}` };
    }
  }
  return undefined;
};

export const createProvider = (id: string, config: ProviderConfig, env: NodeJS.ProcessEnv = process.env): SttProvider => {
  switch (config.type) {
    case "local":
      return createLocalProvider(id, config);
    case "openai-compatible":
      return createOpenAiCompatibleProvider(id, config, env);
    case "deepgram":
      return createDeepgramProvider(id, config, env);
    default: {
      const exhaustive: never = config;
      throw new Error(`unknown provider type: ${JSON.stringify(exhaustive)}`);
    }
  }
};

export type { SttProvider } from "./types.ts";
