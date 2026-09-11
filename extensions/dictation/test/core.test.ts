import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, mergeConfig, type DictationConfig } from "../config.ts";
import { applyReplacements, doctorReport, formatTranscript, transcribeFile } from "../core.ts";
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
