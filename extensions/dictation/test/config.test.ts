import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig, mergeConfig, redactConfig, resolveApiKey, saveConfig } from "../config.ts";

test("mergeConfig keeps defaults for missing keys", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {});
  assert.equal(merged.keybind, DEFAULT_CONFIG.keybind);
  assert.equal(merged.capture.sampleRate, 16000);
  assert.deepEqual(Object.keys(merged.providers).sort(), Object.keys(DEFAULT_CONFIG.providers).sort());
});

test("mergeConfig merges providers per id instead of replacing the map", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    providers: { openai: { type: "openai-compatible", endpoint: "https://example.test/v1/audio/transcriptions", model: "whisper-1" } },
  });
  assert.equal((merged.providers.openai as { endpoint?: string } | undefined)?.endpoint, "https://example.test/v1/audio/transcriptions");
  assert.ok(merged.providers.local, "other providers survive");
});

test("mergeConfig keeps a provider's unset fields from the default entry", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { providers: { deepgram: { apiKeyEnv: "MY_DEEPGRAM" } } });
  const deepgram = merged.providers.deepgram;
  assert.equal(deepgram?.type, "deepgram");
  assert.equal(deepgram?.model, "nova-3");
  assert.equal(deepgram && "apiKeyEnv" in deepgram ? deepgram.apiKeyEnv : undefined, "MY_DEEPGRAM");
});

test("mergeConfig accepts a new custom provider while keeping built-ins", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    providers: { mine: { type: "openai-compatible", endpoint: "http://127.0.0.1:8080/v1/audio/transcriptions", model: "whisper-1" } },
  });
  assert.equal(merged.providers.mine?.type, "openai-compatible");
  assert.ok(merged.providers.openai);
});

test("loadConfig applies env overrides and ignores unknown locales", () => {
  const env = { PI_DICTATION_PROVIDER: "deepgram", PI_DICTATION_KEYBIND: "ctrl+shift+r", PI_DICTATION_LOCALE: "fr" } as NodeJS.ProcessEnv;
  const config = loadConfig({ configPath: "/nonexistent/dictation.json", env });
  assert.equal(config.provider, "deepgram");
  assert.equal(config.keybind, "ctrl+shift+r");
  assert.equal(config.locale, "zh", "unknown locale falls back to the default");
});

test("loadConfig reads a config file and lets env win", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-config-"));
  const configPath = join(dir, "dictation.json");
  writeFileSync(configPath, JSON.stringify({ keybind: "f2", locale: "en", provider: "groq" }));

  const fromFile = loadConfig({ configPath, env: {} as NodeJS.ProcessEnv });
  assert.equal(fromFile.keybind, "f2");
  assert.equal(fromFile.locale, "en");
  assert.equal(fromFile.provider, "groq");

  const overridden = loadConfig({ configPath, env: { PI_DICTATION_PROVIDER: "local" } as NodeJS.ProcessEnv });
  assert.equal(overridden.provider, "local");
  assert.equal(overridden.keybind, "f2");
});

test("loadConfig survives a corrupt config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-config-bad-"));
  const configPath = join(dir, "dictation.json");
  writeFileSync(configPath, "{ not json ");
  const config = loadConfig({ configPath, env: {} as NodeJS.ProcessEnv });
  assert.equal(config.keybind, DEFAULT_CONFIG.keybind);
});

test("resolveApiKey prefers the literal key, then the environment variable", () => {
  const env = { MY_KEY: "from-env" } as NodeJS.ProcessEnv;
  assert.deepEqual(resolveApiKey({ apiKey: "literal", apiKeyEnv: "MY_KEY" }, env).key, "literal");
  assert.deepEqual(resolveApiKey({ apiKeyEnv: "MY_KEY" }, env), { key: "from-env", source: "$MY_KEY" });
  assert.equal(resolveApiKey({ apiKeyEnv: "MISSING" }, env).key, "");
  assert.equal(resolveApiKey({}, env).key, "");
});

test("saveConfig round-trips through loadConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-save-"));
  const configPath = join(dir, "dictation.json");
  saveConfig({ ...DEFAULT_CONFIG, provider: "local", providers: { ...DEFAULT_CONFIG.providers, local: { type: "local", model: "x-asr-480ms-zh-en-punct", language: "auto" } } }, configPath);
  const loaded = loadConfig({ configPath, env: {} as NodeJS.ProcessEnv });
  assert.equal(loaded.provider, "local");
  assert.equal(loaded.providers.local?.type === "local" ? loaded.providers.local.model : "", "x-asr-480ms-zh-en-punct");
});

test("redactConfig never prints a literal key", () => {
  const config = mergeConfig(DEFAULT_CONFIG, { providers: { mine: { type: "openai-compatible", endpoint: "https://x.test/v1", model: "m", apiKey: "sk-secret" } } });
  const printed = JSON.stringify(redactConfig(config));
  assert.ok(!printed.includes("sk-secret"));
  assert.ok(printed.includes("<redacted>"));
});

test("saveConfig leaves no temporary file behind and never truncates the target", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-atomic-"));
  const configPath = join(dir, "dictation.json");
  saveConfig(DEFAULT_CONFIG, configPath);
  saveConfig({ ...DEFAULT_CONFIG, provider: "groq" }, configPath);

  assert.deepEqual(readdirSync(dir), ["dictation.json"], "no .tmp file survives a successful write");
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).provider, "groq");

  // A failed write (unwritable directory) must not damage the existing file.
  const before = readFileSync(configPath, "utf8");
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => saveConfig({ ...DEFAULT_CONFIG, provider: "deepgram" }, configPath));
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(readFileSync(configPath, "utf8"), before);
});
