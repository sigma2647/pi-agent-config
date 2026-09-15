/**
 * Shared core for both entry points:
 *   - index.ts  → the pi extension (interactive dictation)
 *   - dev.ts    → the `pi-dictation` CLI (record / transcribe files / doctor)
 *
 * Everything that has a decision in it lives here, so the two entry points
 * stay thin and cannot drift apart.
 */

import { existsSync, readFileSync } from "node:fs";
import type { OutputConfig, DictationConfig } from "./config.ts";
import { defaultConfigPath } from "./config.ts";
import { detectRecorderTool } from "./audio.ts";
import { modelsRoot, knownModelIds, localModelSpec, type LocalModelSpec } from "./local/catalog.ts";
import { modelState } from "./local/model.ts";
import { describeSilence, probeMic } from "./mic.ts";
import { SILENCE_MAX_AMPLITUDE, isPcm16Wav, pcm16DurationMs } from "./wav.ts";
import { createProvider, providerStatus, providerStatuses, resolveProvider } from "./providers/index.ts";
import type { SttProvider } from "./providers/types.ts";

export const TRANSCRIBE_TIMEOUT_MS = Number.parseInt(process.env.PI_DICTATION_TIMEOUT_MS ?? "", 10) || 90_000;

/**
 * Below this, a cloud request costs more time (and money) than it can return:
 * a mis-tap is not speech. Only applied when the file is a PCM16 WAV we can
 * measure, so formats the provider understands but we cannot (mp3, 24-bit)
 * are still sent as-is.
 */
export const MIN_CLOUD_AUDIO_MS = 300;

export const isTooShortForCloud = (audioPath: string): boolean => {
  try {
    const audio = readFileSync(audioPath);
    return isPcm16Wav(audio) && pcm16DurationMs(audio) < MIN_CLOUD_AUDIO_MS;
  } catch {
    return false;
  }
};

export type TranscribeOptions = {
  config: DictationConfig;
  audioPath: string;
  language?: string | undefined;
  /** Force a provider id instead of the configured one. */
  providerId?: string | undefined;
  signal?: AbortSignal | undefined;
  env?: NodeJS.ProcessEnv;
};

export type TranscribeOutcome = {
  text: string;
  providerId: string;
  providerLabel: string;
};

export type LocalModelRow = {
  id: string;
  label: string;
  languages: string;
  sizeMb: number;
  /** `offline` decodes after you stop, `streaming` writes text while you speak. */
  kind: LocalModelSpec["kind"];
  ready: boolean;
  /** The model `providers.local.model` points at right now. */
  active: boolean;
  dir: string;
};

/**
 * The one place that answers "which local models exist, which is downloaded,
 * which one is in use" — the list and the switch command both read it, so the
 * pi command and the CLI cannot disagree.
 */
export const localModelRows = (config: DictationConfig): LocalModelRow[] => {
  const configured = config.providers.local;
  const activeId = configured?.type === "local" ? configured.model : undefined;
  return knownModelIds().map((id) => {
    const spec = localModelSpec(id)!;
    const state = modelState(id);
    return {
      id,
      label: spec.label,
      languages: spec.languages,
      sizeMb: spec.sizeMb,
      kind: spec.kind,
      ready: state.ready,
      active: id === activeId,
      dir: state.dir,
    };
  });
};

/**
 * The words a model list needs. Each entry point supplies its own locale, but
 * the layout below is written once, so the two lists cannot drift apart.
 */
export type LocalModelWords = {
  kind: Record<LocalModelRow["kind"], string>;
  active: string;
  notDownloaded: string;
  /** The switch line — the whole point of the list: how do I pick the other one? */
  switchHint: (command: string) => string;
  /** Shown right after a switch, so the user can tell it worked and what changed. */
  switched: (id: string, detail: string, configPath: string) => string;
};

/**
 * Feedback for `/dictation model use <id>`: name the model, say what it changes
 * (capability), and when it starts to apply. Without the capability the user has
 * to guess whether "live text while you speak" just went away.
 */
export const describeModelSwitch = (id: string, configPath: string, words: LocalModelWords): string => {
  const spec = localModelSpec(id);
  return words.switched(id, spec ? `${spec.languages} · ${words.kind[spec.kind]}` : "", configPath);
};

/** Model list lines, ready to print. `command` is `/dictation` or `pi-dictation`. */
export const describeLocalModels = (
  config: DictationConfig,
  command: string,
  words: LocalModelWords,
  options: { dirs?: boolean } = {},
): string[] => {
  const lines = localModelRows(config).map((row) => {
    // Two lines per model, so nothing wraps in an 80-column terminal: the id and
    // the state on the first line, the description on the second. The id is the
    // only part that gets typed; long descriptions live in the README.
    const head = `${row.ready ? "✓" : "✗"} ${row.id}${row.active ? ` ${words.active}` : ""}`;
    const detail = [row.languages, words.kind[row.kind]];
    if (!row.ready) detail.push(`${words.notDownloaded} ≈${row.sizeMb} MB`);
    const block = [head, `  ${detail.join(" · ")}`];
    if (options.dirs) block.push(`  ${row.dir}`);
    return block.join("\n");
  });
  lines.push(words.switchHint(command));
  return lines;
};

export type SetLocalModelResult =
  | { ok: true; config: DictationConfig }
  | { ok: false; reason: "unknown" | "missing"; id: string; sizeMb: number };

/**
 * Point `providers.local.model` at another downloaded model. Returns the new
 * config instead of saving it, so each entry point reports and persists the
 * switch in its own way (and the decision stays testable without touching disk).
 */
export const setLocalModel = (config: DictationConfig, id: string): SetLocalModelResult => {
  const spec = localModelSpec(id);
  if (!spec) return { ok: false, reason: "unknown", id, sizeMb: 0 };
  if (!modelState(id).ready) return { ok: false, reason: "missing", id, sizeMb: spec.sizeMb };
  const existing = config.providers.local;
  return {
    ok: true,
    config: {
      ...config,
      providers: {
        ...config.providers,
        local: { type: "local", model: id, language: existing?.type === "local" ? existing.language : "auto" },
      },
    },
  };
};

/**
 * Why the chosen service cannot run, phrased as the fix. An explicitly named
 * provider reports its own reason (a missing API key, a missing model, a
 * missing runtime); "auto" keeps the two generic next actions. Both entry
 * points append this to their "no service ready" message, so the hotkey error
 * names the real cause instead of the two generic ones.
 */
export const notReadyHint = (config: DictationConfig, env: NodeJS.ProcessEnv): string => {
  const named = config.provider === "auto" ? undefined : config.providers[config.provider];
  if (named) return providerStatus(config.provider, named, env).detail;
  return `run /dictation doctor, then either "/dictation model download" or set an API key`;
};

export const transcribeFile = async (options: TranscribeOptions): Promise<TranscribeOutcome> => {
  const env = options.env ?? process.env;
  const config = options.providerId
    ? { ...options.config, provider: options.providerId }
    : options.config;

  const resolved = resolveProvider(config, env);
  if (!resolved) {
    throw new Error(`no speech service is ready (provider: ${config.provider}) — ${notReadyHint(config, env)}`);
  }

  const provider: SttProvider = createProvider(resolved.id, resolved.config, env);
  // Silent skip: no request, no waiting, same result as an empty transcript.
  if (provider.kind === "cloud" && isTooShortForCloud(options.audioPath)) {
    return { text: "", providerId: resolved.id, providerLabel: resolved.status.label };
  }
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

  for (const [id, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig?.type !== "local") continue;
    const status = providerStatus(id, providerConfig, env);
    lines.push({ level: status.ready ? "ok" : "warn", text: `local model ${providerConfig.model}: ${status.detail}` });
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
