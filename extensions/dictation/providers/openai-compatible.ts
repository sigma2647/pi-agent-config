/**
 * OpenAI-compatible `/audio/transcriptions` provider.
 *
 * One implementation covers OpenAI, Groq, SiliconFlow, DashScope, Zhipu, and
 * local servers (whisper.cpp, faster-whisper, sherpa-onnx server) — only the
 * endpoint differs. Loopback endpoints are called without an Authorization
 * header, so a keyless local server works out of the box.
 */

import { readFile } from "node:fs/promises";
import { resolveApiKey, type OpenAICompatibleProviderConfig } from "../config.ts";
import { assertEndpoint, describeHttpFailure, endpointNeedsAuth } from "./endpoint.ts";
import { normalizeLanguage, truncate, type Backend, type SttProvider } from "./types.ts";

export const createOpenAiCompatibleProvider = (
  id: string,
  config: OpenAICompatibleProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): SttProvider => ({
  id,
  label: "OpenAI-compatible",
  kind: "cloud",
  async transcribe(input) {
    const url = assertEndpoint(config.endpoint);
    const needsAuth = endpointNeedsAuth(config.endpoint);
    const { key } = resolveApiKey(config, env);
    if (needsAuth && !key) {
      throw new Error(`missing API key for ${config.endpoint} (set ${config.apiKeyEnv || "providers.*.apiKey"})`);
    }

    const audio = await readFile(input.audioPath);
    const form = new FormData();
    form.append("model", config.model);
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "recording.wav");
    const language = normalizeLanguage(input.language ?? config.language);
    if (language) form.append("language", language);
    if (config.responseFormat) form.append("response_format", config.responseFormat);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        ...(needsAuth ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: form,
      signal: input.signal,
      redirect: "error",
    }).catch(rethrowAbort);

    if (!response.ok) {
      throw new Error(describeHttpFailure("transcription failed", response, await readBody(response)));
    }

    const payload = await readJson(response);
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (!text) throw new Error("transcription response had no text field");
    return { text };
  },
});

export const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

export const readBody = async (response: Response): Promise<string> => {
  try {
    return truncate(await response.text());
  } catch {
    return "";
  }
};

export const rethrowAbort = (error: unknown): never => {
  if (error instanceof Error && error.name === "AbortError") throw new Error("transcription timed out or was cancelled");
  throw error;
};

/**
 * The backend descriptor for the registry. A loopback endpoint counts as ready
 * without a key, which is what makes a local server (whisper.cpp, faster-whisper,
 * qwen3-asr, sherpa-onnx) a one-line config entry instead of new code.
 */
export const openAiCompatibleBackend: Backend<OpenAICompatibleProviderConfig> = {
  create: createOpenAiCompatibleProvider,
  status: (id, config, env) => {
    let local = false;
    try {
      local = !endpointNeedsAuth(config.endpoint);
    } catch (error) {
      return {
        id,
        kind: "cloud",
        label: "openai-compatible",
        ready: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (local) {
      return { id, kind: "cloud", label: `openai-compatible · ${config.model}`, ready: true, detail: `local endpoint ${config.endpoint} (no key needed)` };
    }
    const { key, source } = resolveApiKey(config, env);
    return {
      id,
      kind: "cloud",
      label: `openai-compatible · ${config.model}`,
      ready: Boolean(key),
      detail: key ? `${config.endpoint} (key from ${source})` : `${config.endpoint} — set ${config.apiKeyEnv || "apiKey"}`,
    };
  },
};
