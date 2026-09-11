/** Deepgram pre-recorded listen API (raw audio body, JSON response). */

import { readFile } from "node:fs/promises";
import { resolveApiKey, type DeepgramProviderConfig } from "../config.ts";
import { assertEndpoint, describeHttpFailure } from "./endpoint.ts";
import { normalizeLanguage, type SttProvider } from "./types.ts";
import { readBody, readJson, rethrowAbort } from "./openai-compatible.ts";

export const createDeepgramProvider = (
  id: string,
  config: DeepgramProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): SttProvider => ({
  id,
  label: "Deepgram",
  kind: "cloud",
  async transcribe(input) {
    const url = assertEndpoint(config.endpoint);
    if (config.model) url.searchParams.set("model", config.model);
    const language = normalizeLanguage(input.language ?? config.language);
    if (language) url.searchParams.set("language", language);
    if (config.smartFormat !== false) url.searchParams.set("smart_format", "true");

    const { key } = resolveApiKey(config, env);
    if (!key) throw new Error(`missing Deepgram API key (set ${config.apiKeyEnv || "providers.deepgram.apiKey"})`);

    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Token ${key}`, "Content-Type": "audio/wav" },
      body: new Uint8Array(await readFile(input.audioPath)),
      signal: input.signal,
      redirect: "error",
    }).catch(rethrowAbort);

    if (!response.ok) {
      throw new Error(describeHttpFailure("Deepgram transcription failed", response, await readBody(response)));
    }

    const text = deepgramTranscript(await readJson(response));
    if (!text) throw new Error("Deepgram response had no transcript");
    return { text };
  },
});

export const deepgramTranscript = (payload: Record<string, unknown>): string => {
  const results = record(payload.results);
  const channels = Array.isArray(results.channels) ? results.channels : [];
  const first = record(channels[0]);
  const alternatives = Array.isArray(first.alternatives) ? first.alternatives : [];
  const best = record(alternatives[0]);
  return typeof best.transcript === "string" ? best.transcript.trim() : "";
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
