import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, mergeConfig, type DictationConfig } from "../config.ts";
import { applyReplacements, describeLocalModels, describeModelSwitch, doctorReport, formatTranscript, isTooShortForCloud, setLocalModel, transcribeFile } from "../core.ts";
import { DEFAULT_LOCAL_MODEL, localModelSpec } from "../local/catalog.ts";
import { resolveStrings } from "../strings.ts";
import { wavHeader } from "../audio.ts";
import { isPcm16Wav } from "../wav.ts";
import { providerStatus, resolveProvider } from "../providers/index.ts";
import { deepgramTranscript } from "../providers/deepgram.ts";

const configWith = (patch: Record<string, unknown>): DictationConfig => mergeConfig(DEFAULT_CONFIG, patch);

// Never depend on the developer's real model directory: the local provider is
// pointed at an empty temp dir unless a test sets up its own model files.
const emptyModelsDir = mkdtempSync(join(tmpdir(), "pi-dictation-no-models-"));
process.env.PI_DICTATION_MODELS_DIR = emptyModelsDir;

/** Create a fake (structurally valid) local model inside a temp models dir. */
const withFakeLocalModel = async (run: () => void | Promise<void>): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "pi-dictation-models-"));
  const target = join(root, "sense-voice-small");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "model.int8.onnx"), "fake");
  writeFileSync(join(target, "tokens.txt"), "a 1\n");
  const previous = process.env.PI_DICTATION_MODELS_DIR;
  process.env.PI_DICTATION_MODELS_DIR = root;
  try {
    await run();
  } finally {
    process.env.PI_DICTATION_MODELS_DIR = previous;
  }
};

test("applyReplacements is literal, case-insensitive and longest-first", () => {
  const replacements = { supabase: "Supabase", "super base": "Supabase Pro" };
  assert.equal(applyReplacements("use super base now", replacements), "use Supabase Pro now");
  assert.equal(applyReplacements("USE SUPABASE", replacements), "USE Supabase");
});

test("applyReplacements respects word boundaries in latin text", () => {
  assert.equal(applyReplacements("catalog", { cat: "dog" }), "catalog");
});

test("applyReplacements handles CJK text without word separators", () => {
  assert.equal(applyReplacements("打开配志", { 配志: "配置" }), "打开配置");
});

test("formatTranscript trims and appends a trailing space when configured", () => {
  assert.equal(formatTranscript("  hello  ", { appendTrailingSpace: true, submitOnStop: false, replacements: {} }), "hello ");
  assert.equal(formatTranscript("hello", { appendTrailingSpace: false, submitOnStop: false, replacements: {} }), "hello");
  assert.equal(formatTranscript("   ", { appendTrailingSpace: true, submitOnStop: false, replacements: {} }), "");
});

test("providerStatus reports a missing cloud key with the env var name", () => {
  const config = configWith({ provider: "openai" });
  const status = providerStatus("openai", config.providers.openai!, {} as NodeJS.ProcessEnv);
  assert.equal(status.ready, false);
  assert.match(status.detail, /OPENAI_API_KEY/);
});

test("providerStatus marks a loopback endpoint ready without a key", () => {
  const local = { type: "openai-compatible" as const, endpoint: "http://127.0.0.1:8080/v1/audio/transcriptions", model: "whisper-1" };
  const status = providerStatus("my-local-server", local, {} as NodeJS.ProcessEnv);
  assert.equal(status.ready, true);
  assert.match(status.detail, /no key needed/);
});

test("providerStatus rejects a non-loopback http endpoint", () => {
  const insecure = { type: "openai-compatible" as const, endpoint: "http://api.example.test/v1/audio/transcriptions", model: "whisper-1" };
  const status = providerStatus("insecure", insecure, {} as NodeJS.ProcessEnv);
  assert.equal(status.ready, false);
  assert.match(status.detail, /HTTPS/);
});

test("describeLocalModels marks the model in use, the missing one, and how to switch", () =>
  withFakeLocalModel(() => {
    const config = configWith({ providers: { local: { type: "local", model: "sense-voice-small", language: "zh" } } });
    const lines = describeLocalModels(config, "/dictation", {
      kind: { offline: "OFFLINE", streaming: "STREAMING" },
      active: "ACTIVE",
      notDownloaded: "MISSING",
      switchHint: (command) => `switch via ${command} model use`,
      switched: (id, detail) => `SWITCHED ${id} ${detail}`,
    });

    const hint = lines.at(-1);
    const models = lines.slice(0, -1);
    const active = models.filter((line) => line.includes("ACTIVE"));
    assert.equal(active.length, 1, "exactly one model is marked as in use");
    // Two lines per model: id plus state, then languages and capability. No size
    // for a model that is already on disk.
    assert.match(active[0] ?? "", /^✓ sense-voice-small ACTIVE\n {2}[^·]+ · OFFLINE$/);
    assert.doesNotMatch(active[0] ?? "", /MISSING/);
    assert.doesNotMatch(active[0] ?? "", /MB/, "no download size for a model that is already there");
    assert.ok(
      models.some((line) => /^✗ x-asr-480ms-zh-en-punct\n {2}[^·]+ · STREAMING · MISSING ≈\d+ MB$/.test(line)),
      `the streaming model is listed as not downloaded: ${models.join(" | ")}`,
    );
    assert.equal(hint, "switch via /dictation model use");
  }));

test("describeLocalModels names the caller's own command, so both lists stay runnable", () => {
  const lines = describeLocalModels(configWith({ providers: {} }), "pi-dictation", {
    kind: { offline: "a", streaming: "b" },
    active: "c",
    notDownloaded: "d",
    switchHint: (command) => `${command} model use <id>`,
    switched: (id, detail) => `${id} ${detail}`,
  });
  assert.equal(lines.at(-1), "pi-dictation model use <id>");
});

test("setLocalModel refuses an unknown id and a model that is not downloaded", () => {
  const config = configWith({ providers: { local: { type: "local", model: "sense-voice-small", language: "auto" } } });
  const unknown = setLocalModel(config, "no-such-model");
  assert.deepEqual(unknown, { ok: false, reason: "unknown", id: "no-such-model", sizeMb: 0 });

  const missing = setLocalModel(config, "x-asr-480ms-zh-en-punct");
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.reason, "missing");
  assert.equal(missing.ok === false && missing.sizeMb > 0, true);
});

test("setLocalModel switches the model and keeps the configured language", () =>
  withFakeLocalModel(() => {
    const config = configWith({ providers: { local: { type: "local", model: "x-asr-480ms-zh-en-punct", language: "zh" } } });
    const result = setLocalModel(config, "sense-voice-small");
    assert.equal(result.ok, true);
    const local = result.ok ? result.config.providers.local : undefined;
    assert.deepEqual(local, { type: "local", model: "sense-voice-small", language: "zh" });
    // The original config must not be mutated by the returned switch.
    assert.equal(config.providers.local?.type === "local" && config.providers.local.model, "x-asr-480ms-zh-en-punct");
  }));

test("resolveProvider honours an explicit provider choice", () => {
  const config = configWith({ provider: "openai" });
  const resolved = resolveProvider(config, { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
  assert.equal(resolved?.id, "openai");
  assert.match(resolved?.reason ?? "", /configured provider/);
});

test("resolveProvider returns nothing when the chosen provider is not ready", () => {
  const config = configWith({ provider: "deepgram" });
  assert.equal(resolveProvider(config, {} as NodeJS.ProcessEnv), undefined);
});

test("resolveProvider auto prefers a ready local model over a ready cloud provider", async () => {
  await withFakeLocalModel(() => {
    const config = configWith({
      providers: {
        local: { type: "local", model: "sense-voice-small", language: "auto" },
        openai: { type: "openai-compatible", endpoint: "https://api.test/v1/audio/transcriptions", model: "whisper-1", apiKeyEnv: "OPENAI_API_KEY" },
      },
    });
    const resolved = resolveProvider(config, { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    assert.equal(resolved?.id, "local");
    assert.match(resolved?.reason ?? "", /auto:/);
  });
});

test("resolveProvider auto falls back to the first ready cloud provider when local is absent", () => {
  const config = configWith({
    providers: {
      local: { type: "local", model: "sense-voice-small", language: "auto" },
      openai: { type: "openai-compatible", endpoint: "https://api.test/v1/audio/transcriptions", model: "whisper-1", apiKeyEnv: "OPENAI_API_KEY" },
    },
  });
  const resolved = resolveProvider(config, { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
  assert.equal(resolved?.id, "openai");
  assert.match(resolved?.reason ?? "", /auto:/);
});

test("resolveProvider returns nothing when auto finds no ready provider", () => {
  const config = configWith({ providers: { openai: { type: "openai-compatible", endpoint: "https://api.test/v1", model: "whisper-1", apiKeyEnv: "OPENAI_API_KEY" } } });
  assert.equal(resolveProvider(config, {} as NodeJS.ProcessEnv), undefined);
});

test("transcribeFile fails with an actionable message when nothing is ready", async () => {
  const config = configWith({ provider: "auto", providers: {} });
  await assert.rejects(() => transcribeFile({ config, audioPath: "/tmp/none.wav", env: {} as NodeJS.ProcessEnv }), /no speech service is ready/);
});

test("doctorReport fails when no recorder and no provider are available", () => {
  const config = configWith({ providers: {} });
  const report = doctorReport(config, { PATH: "/nonexistent" } as NodeJS.ProcessEnv);
  assert.equal(report.ok, false);
  assert.ok(report.lines.some((line) => line.level === "fail" && line.text.includes("recorder")));
});

test("doctorReport passes with a recorder on PATH and a keyed provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-bin-"));
  const ffmpeg = join(dir, "ffmpeg");
  writeFileSync(ffmpeg, "#!/bin/sh\nexit 0\n");
  chmodSync(ffmpeg, 0o755);

  const config = configWith({ providers: { openai: { type: "openai-compatible", endpoint: "https://api.test/v1/audio/transcriptions", model: "whisper-1", apiKeyEnv: "OPENAI_API_KEY" } } });
  const report = doctorReport(config, { PATH: dir, OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
  assert.equal(report.ok, true);
  assert.ok(report.lines.some((line) => line.text.includes("selected: openai")));
});

test("deepgramTranscript reads the first alternative of the first channel", () => {
  const payload = {
    results: { channels: [{ alternatives: [{ transcript: "  hello world ", confidence: 0.9 }] }, { alternatives: [{ transcript: "ignored" }] }] },
  };
  assert.equal(deepgramTranscript(payload), "hello world");
  assert.equal(deepgramTranscript({}), "");
  assert.equal(deepgramTranscript({ results: { channels: [] } }), "");
});

/** A structurally valid 16 kHz mono PCM16 WAV of the given length. */
const wavOf = (ms: number): Buffer => {
  const pcm = Buffer.alloc(Math.round((16000 * 2 * ms) / 1000));
  return Buffer.concat([wavHeader(pcm.length, { sampleRate: 16000, channels: 1 }), pcm]);
};

test("isTooShortForCloud only skips audio it can actually measure", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-short-"));
  const short = join(dir, "short.wav");
  const long = join(dir, "long.wav");
  const mp3 = join(dir, "note.mp3");
  writeFileSync(short, wavOf(120));
  writeFileSync(long, wavOf(1500));
  writeFileSync(mp3, Buffer.from("ID3 this is not audio we can measure"));

  assert.equal(isTooShortForCloud(short), true);
  assert.equal(isTooShortForCloud(long), false);
  assert.equal(isTooShortForCloud(mp3), false, "an unmeasurable format must reach the provider unchanged");
  assert.equal(isTooShortForCloud(join(dir, "missing.wav")), false);
  assert.equal(isPcm16Wav(wavOf(10)), true);
  assert.equal(isPcm16Wav(Buffer.from("RIFF????WAVE")), false, "a WAV without a fmt chunk is not measurable");
});

test("a too-short cloud recording is skipped instead of uploaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-skip-"));
  const audioPath = join(dir, "short.wav");
  writeFileSync(audioPath, wavOf(120));

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("the cloud provider must not be called for a mis-tap");
  }) as typeof fetch;
  try {
    const outcome = await transcribeFile({
      config: configWith({ provider: "openai" }),
      audioPath,
      env: { OPENAI_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    });
    assert.equal(outcome.text, "");
    assert.equal(outcome.providerId, "openai");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("describeModelSwitch says which model, what it changes, and when it applies", () => {
  const message = describeModelSwitch(DEFAULT_LOCAL_MODEL, "/tmp/dictation.json", resolveStrings("zh").model);
  assert.match(message, new RegExp(`已切到 ${DEFAULT_LOCAL_MODEL}`));
  assert.match(message, /说完再出字/, "the capability change is the part the user cannot guess");
  assert.match(message, /下一次录音生效/);
  assert.match(message, /\/tmp\/dictation\.json/);
  // An id with no catalog entry must not produce "undefined" in the message.
  assert.doesNotMatch(describeModelSwitch(DEFAULT_LOCAL_MODEL, "/tmp/x.json", resolveStrings("en").model), /undefined/);
  assert.ok(localModelSpec(DEFAULT_LOCAL_MODEL));
});
