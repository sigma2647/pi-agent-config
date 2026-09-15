/**
 * Backend registry: one place that answers three questions.
 *   1. which providers are configured,
 *   2. which of them can actually run right now,
 *   3. which one `provider: "auto"` picks (first ready in AUTO_PROVIDER_ORDER).
 *
 * Every backend — the in-process local runtime and every cloud service — has the
 * same shape (`Backend` in `./types.ts`): how to run it, and how to say whether
 * it can run. Adding a service is a new file plus one line in `BACKENDS`; nothing
 * in this file has to change, and TypeScript refuses to compile if a config type
 * is left without a backend.
 */

import { AUTO_PROVIDER_ORDER, type DictationConfig, type ProviderConfig } from "../config.ts";
import { localBackend } from "../local/backend.ts";
import { deepgramBackend } from "./deepgram.ts";
import { openAiCompatibleBackend } from "./openai-compatible.ts";
import type { Backend, ProviderStatus, SttProvider } from "./types.ts";

/** Config `type` → the code that runs it. The only such list in the extension. */
const BACKENDS: { [Type in ProviderConfig["type"]]: Backend<Extract<ProviderConfig, { type: Type }>> } = {
  local: localBackend,
  "openai-compatible": openAiCompatibleBackend,
  deepgram: deepgramBackend,
};

/**
 * TypeScript cannot correlate the map key with the matching member of the config
 * union, so the single cast lives here rather than in a switch at every call site.
 */
const backendFor = (type: ProviderConfig["type"]): Backend<ProviderConfig> => BACKENDS[type] as Backend<ProviderConfig>;

export const providerStatus = (id: string, config: ProviderConfig, env: NodeJS.ProcessEnv = process.env): ProviderStatus =>
  backendFor(config.type).status(id, config, env);

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

export const createProvider = (id: string, config: ProviderConfig, env: NodeJS.ProcessEnv = process.env): SttProvider =>
  backendFor(config.type).create(id, config, env);

export type { Backend, ProviderStatus, SttProvider } from "./types.ts";
