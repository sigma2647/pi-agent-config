/**
 * Shared core for both entry points:
 *   - index.ts  → the pi extension (interactive dictation)
 *   - dev.ts    → the `pi-dictation` CLI (record / transcribe files / doctor)
 *
 * Everything that has a decision in it lives here, so the two entry points
 * stay thin and cannot drift apart.
 */

import { existsSync } from "node:fs";
import type { OutputConfig, DictationConfig } from "./config.ts";
import { defaultConfigPath } from "./config.ts";
import { detectRecorderTool } from "./audio.ts";
import { localModelSpec, modelsRoot } from "./local/catalog.ts";
import { modelState } from "./local/model.ts";
import { describeSilence, probeMic } from "./mic.ts";
import { SILENCE_MAX_AMPLITUDE } from "./wav.ts";
import { createProvider, providerStatuses, resolveProvider } from "./providers/index.ts";
import type { SttProvider } from "./providers/types.ts";

export const TRANSCRIBE_TIMEOUT_MS = Number.parseInt(process.env.PI_DICTATION_TIMEOUT_MS ?? "", 10) || 90_000;

export type TranscribeOptions = {
  config: DictationConfig;
  audioPath: string;
  language?: string;
  /** Force a provider id instead of the configured one. */
  providerId?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};

export type TranscribeOutcome = {
  text: string;
  providerId: string;
  providerLabel: string;
};

export const transcribeFile = async (options: TranscribeOptions): Promise<TranscribeOutcome> => {
  const env = options.env ?? process.env;
  const config = options.providerId
    ? { ...options.config, provider: options.providerId }
    : options.config;

  const resolved = resolveProvider(config, env);
  if (!resolved) {
    throw new Error(
      `no speech service is ready (provider: ${config.provider}). Run /dictation doctor, then either "/dictation model download" or set an API key.`,
    );
  }

  const provider: SttProvider = createProvider(resolved.id, resolved.config, env);
  const signal = options.signal ?? AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS);
  const result = await provider.transcribe({ audioPath: options.audioPath, language: options.language, signal });
  return { text: result.text.trim(), providerId: resolved.id, providerLabel: resolved.status.label };
};

/** Literal, case-insensitive, word-boundary replacements; longer keys win. */
export const applyReplacements = (text: string, replacements: Record<string, string>): string => {
  if (!text) return text;
  const keys = Object.keys(replacements)
    .filter((key) => key.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const key of keys) {
    const pattern = new RegExp(boundaryPattern(key), "gi");
    result = result.replace(pattern, replacements[key] ?? "");
  }
  return result;
};

export const formatTranscript = (text: string, output: OutputConfig): string => {
  const normalized = text.trim();
  if (!normalized) return "";
  return output.appendTrailingSpace ? `${normalized} ` : normalized;
};

/** One-line summary of what dictation would do right now, for status output. */
export const describeSelection = (config: DictationConfig, env: NodeJS.ProcessEnv = process.env): string => {
  const resolved = resolveProvider(config, env);
  if (!resolved) return `provider: none ready (configured: ${config.provider})`;
  return `provider: ${resolved.id} (${resolved.status.detail})`;
};

export type DoctorLine = { level: "ok" | "warn" | "fail"; text: string };
export type DoctorReport = { ok: boolean; lines: DoctorLine[] };

/** Readiness report. Purely local checks: files on disk, PATH, environment keys. */
export const doctorReport = (config: DictationConfig, env: NodeJS.ProcessEnv = process.env): DoctorReport => {
  const lines: DoctorLine[] = [];

  const recorder = detectRecorderTool(config.capture, env);
  lines.push(
    recorder.tool
      ? { level: "ok", text: `recorder ${recorder.tool}: ${recorder.detail}` }
      : { level: "fail", text: `recorder: ${recorder.detail}` },
  );
  lines.push({
    level: config.capture.sampleRate === 16000 ? "ok" : "warn",
    text: `capture: ${config.capture.sampleRate} Hz, ${config.capture.channels} ch, max ${config.capture.maxSeconds}s, device ${config.capture.device || "auto"}`,
  });

  const statuses = providerStatuses(config, env);
  for (const status of statuses) {
    lines.push({
      level: status.ready ? "ok" : status.kind === "local" ? "warn" : "warn",
      text: `provider ${status.id} [${status.kind}]: ${status.detail}`,
    });
  }

  const resolved = resolveProvider(config, env);
  if (resolved) {
    lines.push({ level: "ok", text: `selected: ${resolved.id} — ${resolved.reason}` });
  } else {
    lines.push({
      level: "fail",
      text: `selected: none — run "/dictation model download" for offline use, or set an API key for a cloud provider`,
    });
  }

  for (const id of Object.keys(config.providers)) {
    const providerConfig = config.providers[id];
    if (providerConfig?.type !== "local") continue;
    const spec = localModelSpec(providerConfig.model);
    const state = modelState(providerConfig.model);
    lines.push({
      level: state.ready ? "ok" : "warn",
      text: `local model ${providerConfig.model}: ${state.ready ? `ready (${state.dir})` : spec ? `missing — /dictation model download (≈${spec.sizeMb} MB)` : "unknown model id"}`,
    });
  }

  const configPath = process.env.PI_DICTATION_CONFIG?.trim() || defaultConfigPath();
  lines.push({ level: existsSync(configPath) ? "ok" : "warn", text: `config: ${existsSync(configPath) ? configPath : `${configPath} (not created yet — defaults in use)`}` });
  lines.push({ level: "ok", text: `models dir: ${modelsRoot()}` });

  const ok = Boolean(recorder.tool) && Boolean(resolved);
  return { ok, lines };
};

/**
 * Live microphone check: record a short sample and report the peak level plus
 * the available inputs. This is what turns "recording is silent" into an
 * actionable answer (wrong/suspended/wireless-off device).
 */
export const micDiagnostics = async (config: DictationConfig, ms = 400): Promise<DoctorLine[]> => {
  if (!detectRecorderTool(config.capture).tool) {
    return [{ level: "fail", text: "mic: no recorder available, cannot sample the microphone" }];
  }

  const probe = await probeMic(config.capture, ms);
  const lines: DoctorLine[] = [
    {
      level: probe.peak > SILENCE_MAX_AMPLITUDE ? "ok" : "warn",
      text:
        `mic: peak ${probe.peak} over ${probe.bytes} bytes` +
        (probe.defaultSource ? ` · default source "${probe.defaultSource}"` : "") +
        (probe.warning ? ` · ${probe.warning}` : ""),
    },
  ];

  if (probe.peak <= SILENCE_MAX_AMPLITUDE) {
    lines.push({ level: "warn", text: `mic: ${describeSilence(probe)}` });
  }
  if (probe.devices.length > 0) {
    lines.push({
      level: "ok",
      text: `mic inputs: ${probe.devices.map((device) => `${device.name}${device.isDefault ? " (default)" : ""}`).join(", ")}`,
    });
  }
  return lines;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Word boundaries only make sense next to ASCII word characters. CJK text has
 * no separators, so a key like "配志" must match inside "打开配志".
 */
const boundaryPattern = (key: string): string => {
  const leading = /^[A-Za-z0-9_]/.test(key) ? "(?<![A-Za-z0-9_])" : "";
  const trailing = /[A-Za-z0-9_]$/.test(key) ? "(?![A-Za-z0-9_])" : "";
  return `${leading}${escapeRegExp(key)}${trailing}`;
};
