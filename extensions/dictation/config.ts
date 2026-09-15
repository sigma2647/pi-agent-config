/**
 * Configuration for the `dictation` extension: one file, one shape, one place.
 *
 * File: `~/.pi/agent/dictation.json` (override with `PI_DICTATION_CONFIG`).
 * Env overrides win at startup: `PI_DICTATION_PROVIDER`, `PI_DICTATION_KEYBIND`,
 * `PI_DICTATION_LOCALE`. Everything else is file-only, so a running session has
 * one predictable source of truth.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Locale = "zh" | "en";

export type LocalProviderConfig = {
  type: "local";
  /** Catalog id, see local/catalog.ts */
  model: string;
  language: string;
};

export type OpenAICompatibleProviderConfig = {
  type: "openai-compatible";
  endpoint: string;
  model: string;
  language?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  responseFormat?: string;
};

export type DeepgramProviderConfig = {
  type: "deepgram";
  endpoint: string;
  model: string;
  language?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  smartFormat?: boolean;
};

export type ProviderConfig = LocalProviderConfig | OpenAICompatibleProviderConfig | DeepgramProviderConfig;

export type CaptureTool = "auto" | "ffmpeg" | "pw-record" | "arecord" | "sox";

/** `hold` = press to start, release to stop (needs terminal key-release events). */
export type KeybindMode = "hold" | "toggle";

export type CaptureConfig = {
  tool: CaptureTool;
  /** Tool-specific input selector: pulse/avfoundation/dshow source, or a device name. */
  device: string;
  ffmpegPath: string;
  sampleRate: number;
  channels: number;
  maxSeconds: number;
  minBytes: number;
};

export type OutputConfig = {
  appendTrailingSpace: boolean;
  submitOnStop: boolean;
  replacements: Record<string, string>;
};

export type DictationConfig = {
  locale: Locale;
  keybind: string;
  keybindMode: KeybindMode;
  /** "auto" picks the first ready provider in AUTO_PROVIDER_ORDER. */
  provider: string;
  providers: Record<string, ProviderConfig>;
  capture: CaptureConfig;
  output: OutputConfig;
};

/**
 * Deterministic preference order for `provider: "auto"`.
 * Offline first (no network, no key, no cost), then hosted providers.
 */
export const AUTO_PROVIDER_ORDER = ["local", "openai", "groq", "siliconflow", "glm", "deepgram"] as const;

export const DEFAULT_CONFIG: DictationConfig = {
  locale: "zh",
  // ctrl+r also means "rename session" in pi; this extension wins the binding
  // (pi prints an extension-shortcut conflict note). To silence it, add
  // `"app.session.rename": []` to ~/.pi/agent/keybindings.json.
  keybind: "ctrl+r",
  // Default is hold-to-talk: record while the key is held, stop when it comes
  // up. Terminals with key-release events (ghostty/kitty/wezterm) hand the
  // release over directly; everywhere else the extension reads the gap in the
  // auto-repeat stream instead, so "hold" works in every terminal. Switch to
  // "toggle" (press to start, press to stop) with `/dictation mode toggle`.
  keybindMode: "hold",
  provider: "auto",
  providers: {
    local: { type: "local", model: "sense-voice-small", language: "auto" },
    openai: {
      type: "openai-compatible",
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      model: "whisper-1",
      language: "auto",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    groq: {
      type: "openai-compatible",
      endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
      model: "whisper-large-v3-turbo",
      language: "auto",
      apiKeyEnv: "GROQ_API_KEY",
    },
    siliconflow: {
      type: "openai-compatible",
      endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions",
      model: "FunAudioLLM/SenseVoiceSmall",
      language: "auto",
      apiKeyEnv: "SILICONFLOW_API_KEY",
    },
    // Zhipu GLM-ASR. Its `/audio/transcriptions` takes the same multipart form
    // as OpenAI's, so it is a config entry and no new code. The service rejects
    // one upload longer than 30 s; unlike the local models it cannot be given a
    // longer recording, so keep dictations short when this is the active provider.
    glm: {
      type: "openai-compatible",
      endpoint: "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions",
      model: "glm-asr-2512",
      language: "auto",
      apiKeyEnv: "GLM_API_KEY",
    },
    deepgram: {
      type: "deepgram",
      endpoint: "https://api.deepgram.com/v1/listen",
      model: "nova-3",
      language: "auto",
      apiKeyEnv: "DEEPGRAM_API_KEY",
      smartFormat: true,
    },
  },
  capture: {
    tool: "auto",
    device: "",
    ffmpegPath: "ffmpeg",
    sampleRate: 16000,
    channels: 1,
    maxSeconds: 120,
    minBytes: 512,
  },
  output: {
    appendTrailingSpace: true,
    submitOnStop: false,
    replacements: {},
  },
};

export const defaultConfigPath = (): string => process.env.PI_DICTATION_CONFIG?.trim() || join(homedir(), ".pi", "agent", "dictation.json");

export const readConfigFile = (configPath: string): Record<string, unknown> => {
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Write the resolved config so the user can discover and edit it. Never overwrites an existing file. */
export const ensureConfigFile = (configPath: string): boolean => {
  if (existsSync(configPath)) return false;
  try {
    saveConfig(DEFAULT_CONFIG, configPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Persist the current config. Used by `/dictation provider` and `/dictation model use`.
 *
 * Written to a temporary file and renamed into place: a crash (or a full disk)
 * halfway through must not leave the user with a truncated config. rename is
 * atomic on the same filesystem, and the temp name carries the pid so two
 * sessions cannot clobber each other's half-written file.
 */
export const saveConfig = (config: DictationConfig, configPath = defaultConfigPath()): void => {
  mkdirSync(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, configPath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      /* keep the original write error */
    }
    throw error;
  }
};

export type LoadConfigOptions = {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
};

export const loadConfig = (options: LoadConfigOptions = {}): DictationConfig => {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? defaultConfigPath();
  const file = readConfigFile(configPath);
  const config = mergeConfig(DEFAULT_CONFIG, file);

  const envProvider = env.PI_DICTATION_PROVIDER?.trim();
  if (envProvider) config.provider = envProvider;
  const envKeybind = env.PI_DICTATION_KEYBIND?.trim();
  if (envKeybind) config.keybind = envKeybind;
  const envKeybindMode = env.PI_DICTATION_KEYBIND_MODE?.trim().toLowerCase();
  if (envKeybindMode === "hold" || envKeybindMode === "toggle") config.keybindMode = envKeybindMode;
  const envLocale = env.PI_DICTATION_LOCALE?.trim().toLowerCase();
  if (envLocale === "zh" || envLocale === "en") config.locale = envLocale;

  return config;
};

/**
 * Shallow-per-section merge over the defaults: unknown keys are kept (forward
 * compatibility), known sections are filled in field by field. `providers` is
 * merged per provider id so adding one provider does not drop the others.
 */
export const mergeConfig = (base: DictationConfig, override: Record<string, unknown>): DictationConfig => {
  const providers: Record<string, ProviderConfig> = { ...base.providers };
  const overrideProviders = override.providers;
  if (isRecord(overrideProviders)) {
    for (const [id, value] of Object.entries(overrideProviders)) {
      if (!isRecord(value)) continue;
      const existing = providers[id];
      providers[id] = (existing ? { ...existing, ...value } : value) as unknown as ProviderConfig;
    }
  }

  return {
    locale: override.locale === "en" || override.locale === "zh" ? override.locale : base.locale,
    keybind: text(override.keybind) ?? base.keybind,
    keybindMode: override.keybindMode === "toggle" || override.keybindMode === "hold" ? override.keybindMode : base.keybindMode,
    provider: text(override.provider) ?? base.provider,
    providers,
    capture: { ...base.capture, ...recordSection(override.capture) } as CaptureConfig,
    output: { ...base.output, ...recordSection(override.output) } as OutputConfig,
  };
};

export const resolvePath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
};

/** API key from config: `apiKey` literal, else `apiKeyEnv` variable. Empty string means "not configured". */
export const resolveApiKey = (
  provider: { apiKey?: string; apiKeyEnv?: string },
  env: NodeJS.ProcessEnv = process.env,
): { key: string; source: string } => {
  const literal = provider.apiKey?.trim();
  if (literal) return { key: literal, source: "providers.*.apiKey" };
  const envName = provider.apiKeyEnv?.trim();
  if (!envName) return { key: "", source: "" };
  const value = env[envName]?.trim() ?? "";
  return { key: value, source: value ? `$${envName}` : `$${envName} (unset)` };
};

/** Config view for display: secrets are never printed. */
export const redactConfig = (config: DictationConfig): Record<string, unknown> => {
  const providers: Record<string, unknown> = {};
  for (const [id, provider] of Object.entries(config.providers)) {
    const copy: Record<string, unknown> = { ...provider };
    if (typeof copy.apiKey === "string" && copy.apiKey) copy.apiKey = "<redacted>";
    providers[id] = copy;
  }
  return { ...config, providers };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const recordSection = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};
