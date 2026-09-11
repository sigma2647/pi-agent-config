/**
 * Local model lifecycle tests. Nothing here downloads anything: the download
 * path is exercised with an unknown id (fails before touching the network).
 *
 * A real end-to-end transcription runs only when PI_DICTATION_LOCAL_TEST=1 and a
 * model directory is present — see PI_DICTATION_MODELS_DIR.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_LOCAL_MODEL, isStreamingModel, localModelSpec, modelDir, modelsRoot } from "../local/catalog.ts";
import { deleteModel, downloadModel, modelState } from "../local/model.ts";
import { createLocalProvider } from "../local/provider.ts";
import { createStreamingSession, pcmToSamples } from "../local/streaming.ts";
import { loadSherpa } from "../local/sherpa.ts";

const STREAMING_MODEL = "x-asr-480ms-zh-en-punct";

const withModelsDir = (run: (dir: string) => void | Promise<void>) => async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-models-"));
  const previous = process.env.PI_DICTATION_MODELS_DIR;
  process.env.PI_DICTATION_MODELS_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_DICTATION_MODELS_DIR;
    else process.env.PI_DICTATION_MODELS_DIR = previous;
  }
};

test("modelState reports the missing files of an absent model", withModelsDir((dir) => {  const state = modelState(DEFAULT_LOCAL_MODEL);
  assert.equal(state.ready, false);
  assert.equal(state.dir, join(dir, DEFAULT_LOCAL_MODEL));
  assert.deepEqual(state.missing, ["model.int8.onnx", "tokens.txt"]);
  assert.equal(modelsRoot(), dir);
}));

test("modelState is ready once every required file exists", withModelsDir((dir) => {
  const target = modelDir(DEFAULT_LOCAL_MODEL);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "model.int8.onnx"), "fake weights");
  assert.equal(modelState(DEFAULT_LOCAL_MODEL).ready, false, "tokens.txt is still missing");
  writeFileSync(join(target, "tokens.txt"), "a 1\n");
  assert.equal(modelState(DEFAULT_LOCAL_MODEL).ready, true);
}));

test("deleteModel removes the model directory and reports what it removed", withModelsDir(async () => {
  const target = modelDir(DEFAULT_LOCAL_MODEL);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "tokens.txt"), "a 1\n");
  const { removed } = await deleteModel(DEFAULT_LOCAL_MODEL);
  assert.deepEqual(removed, [target]);
  assert.equal(modelState(DEFAULT_LOCAL_MODEL).ready, false);
}));

test("deleteModel on an absent model removes nothing", withModelsDir(async () => {
  const { removed } = await deleteModel(DEFAULT_LOCAL_MODEL);
  assert.deepEqual(removed, []);
}));

test("downloadModel rejects an unknown model id before any network access", async () => {
  await assert.rejects(() => downloadModel("not-a-model"), /unknown local model/);
});

test("the local provider reports a missing model instead of crashing", async () => {
  const previous = process.env.PI_DICTATION_MODELS_DIR;
  process.env.PI_DICTATION_MODELS_DIR = mkdtempSync(join(tmpdir(), "pi-dictation-empty-"));
  try {
    const provider = createLocalProvider("local", { model: DEFAULT_LOCAL_MODEL, language: "auto" });
    assert.equal(provider.kind, "local");
    await assert.rejects(
      () => provider.transcribe({ audioPath: "/tmp/does-not-exist.wav", signal: AbortSignal.timeout(2000) }),
      /not downloaded/,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_DICTATION_MODELS_DIR;
    else process.env.PI_DICTATION_MODELS_DIR = previous;
  }
});

test("an opt-in run transcribes a bundled test wav with the real model", { skip: process.env.PI_DICTATION_LOCAL_TEST !== "1" }, async () => {
  const model = modelDir(DEFAULT_LOCAL_MODEL);
  const wav = join(model, "test_wavs", "zh.wav");
  const provider = createLocalProvider("local", { model: DEFAULT_LOCAL_MODEL, language: "auto" });
  const { text } = await provider.transcribe({ audioPath: wav, signal: AbortSignal.timeout(60_000) });
  assert.ok(text.length > 0, "the local model produced text");
  process.stdout.write(`  ↳ local transcript: ${text}\n`);
});

// ── Streaming model ───────────────────────────────────────────────────────

test("the catalog describes the streaming model completely", () => {
  const spec = localModelSpec(STREAMING_MODEL);
  assert.ok(spec, "the streaming model is in the catalog");
  assert.equal(spec.kind, "streaming");
  assert.equal(isStreamingModel(STREAMING_MODEL), true);
  assert.equal(isStreamingModel(DEFAULT_LOCAL_MODEL), false);
  assert.deepEqual(spec.files, [spec.encoder, spec.decoder, spec.joiner, spec.tokens]);
  for (const file of spec.files) assert.ok(file && file.length > 0);
});

test("a streaming session explains a missing model instead of crashing", withModelsDir(async () => {
  await assert.rejects(() => createStreamingSession(STREAMING_MODEL, 16000), /not downloaded/);
}));

test("pcmToSamples converts PCM16 to float and carries an odd trailing byte", () => {
  const pcm = Buffer.alloc(5);
  pcm.writeInt16LE(0, 0);
  pcm.writeInt16LE(-32768, 2);
  pcm.writeUInt8(0x7f, 4);
  const { samples, rest } = pcmToSamples(pcm);
  assert.equal(samples.length, 2);
  assert.equal(samples[0], 0);
  assert.equal(samples[1], -1);
  assert.equal(rest?.length, 1, "half a sample waits for the next chunk");
  assert.equal(pcmToSamples(Buffer.alloc(4)).rest, undefined);
});

/**
 * The point of the streaming model: text appears before the recording ends.
 * Needs a real model (155 MB unpacked), so it is opt-in like the offline test.
 */
test("an opt-in run produces partial text before the audio ends", { skip: process.env.PI_DICTATION_LOCAL_TEST !== "1" }, async () => {
  const spec = localModelSpec(STREAMING_MODEL)!;
  const wav = join(modelDir(STREAMING_MODEL), "test_wavs", "0.wav");
  const runtime = await loadSherpa();
  const wave = runtime.readWave(wav);
  const half = Math.floor(wave.samples.length / 2);

  const session = await createStreamingSession(STREAMING_MODEL, wave.sampleRate);
  try {
    session.pushSamples(wave.samples.subarray(0, half));
    const partial = session.step();
    assert.ok(partial.length > 0, "half the audio already yields text");

    session.pushSamples(wave.samples.subarray(half));
    const final = session.finish();
    assert.ok(final.length >= partial.length, `final ${JSON.stringify(final)} must extend partial ${JSON.stringify(partial)}`);
    assert.equal(session.pendingSamples(), 0, "nothing is left undecoded");
    process.stdout.write(`  ↳ ${spec.label}: partial ${JSON.stringify(partial)} → final ${JSON.stringify(final)}\n`);
  } finally {
    session.free();
  }

  const provider = createLocalProvider("local", { model: STREAMING_MODEL, language: "auto" });
  const { text } = await provider.transcribe({ audioPath: wav, signal: AbortSignal.timeout(60_000) });
  assert.ok(text.length > 0, "a file transcribed through the streaming model is not empty");
  process.stdout.write(`  ↳ file through streaming provider: ${JSON.stringify(text)}\n`);
});
