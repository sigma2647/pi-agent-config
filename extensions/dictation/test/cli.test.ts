/**
 * `pi-dictation` CLI smoke tests: the dev.ts branches run as real subprocesses
 * against a temp config and a fake local model, so `model use` and `mode` are
 * covered end to end (exit codes, output, written config) — the part the core
 * unit tests cannot see, because it lives in the CLI wiring.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const DEV_TS = fileURLToPath(new URL("../dev.ts", import.meta.url));

const runCli = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", DEV_TS, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });

/** A temp config path plus a models dir with a fake (structurally valid) SenseVoice. */
const scenario = (): { configPath: string; env: Record<string, string> } => {
  const work = mkdtempSync(join(tmpdir(), "pi-dictation-cli-"));
  const configPath = join(work, "dictation.json");
  const models = join(work, "models");
  mkdirSync(join(models, "sense-voice-small"), { recursive: true });
  writeFileSync(join(models, "sense-voice-small", "model.int8.onnx"), "fake");
  writeFileSync(join(models, "sense-voice-small", "tokens.txt"), "a 1\n");
  return { configPath, env: { PI_DICTATION_CONFIG: configPath, PI_DICTATION_MODELS_DIR: models } };
};

test("cli: model use switches the model and writes the config file", () => {
  const s = scenario();
  const result = runCli(["model", "use", "sense-voice-small"], s.env);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /sense-voice-small/, "the confirmation names the model");
  const saved = JSON.parse(readFileSync(s.configPath, "utf8")) as { providers: { local: { model: string } } };
  assert.equal(saved.providers.local.model, "sense-voice-small");
});

test("cli: model use fails on an unknown id", () => {
  const s = scenario();
  const result = runCli(["model", "use", "no-such-model"], s.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown local model/);
});

test("cli: mode without an argument shows the current mode", () => {
  const s = scenario();
  const result = runCli(["mode"], s.env);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /hold/, "hold is the default key mode");
});

test("cli: mode switches the key mode and saves it", () => {
  const s = scenario();
  const result = runCli(["mode", "toggle"], s.env);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /toggle/);
  const saved = JSON.parse(readFileSync(s.configPath, "utf8")) as { keybindMode: string };
  assert.equal(saved.keybindMode, "toggle");
});

test("cli: mode rejects anything but hold or toggle", () => {
  const s = scenario();
  const result = runCli(["mode", "sideways"], s.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hold or toggle/);
});
