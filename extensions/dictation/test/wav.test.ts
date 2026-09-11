import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SILENCE_MAX_AMPLITUDE,
  normalizeLevel,
  pcm16DurationMs,
  pcmLevels,
  peakPcm16LeAmplitude,
} from "../wav.ts";

/** Build a minimal 16 kHz mono PCM16LE WAV from raw sample values. */
const wav = (samples: number[], sampleRate = 16000): Buffer => {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

const pcm = (samples: number[]): Buffer => {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  return data;
};

test("peakPcm16LeAmplitude finds the loudest sample", () => {
  assert.equal(peakPcm16LeAmplitude(wav([0, 100, -3000, 12])), 3000);
});

test("peakPcm16LeAmplitude returns undefined for non-WAV data", () => {
  assert.equal(peakPcm16LeAmplitude(Buffer.from("not a wav file at all........")), undefined);
});

test("digital silence is below the silence threshold", () => {
  assert.equal(peakPcm16LeAmplitude(wav([0, 0, 0, 0])), 0);
  assert.ok(0 <= SILENCE_MAX_AMPLITUDE);
});

test("pcm16DurationMs uses the payload size", () => {
  // 16000 samples = 1 second at 16 kHz.
  assert.equal(pcm16DurationMs(wav(new Array(16000).fill(0))), 1000);
});

test("pcmLevels returns one level per slice, oldest first", () => {
  // Two 20 ms slices at 16 kHz: 320 samples each. First quiet, second loud.
  const quiet = new Array(320).fill(0);
  const loud = new Array(320).fill(8000);
  const levels = pcmLevels(pcm([...quiet, ...loud]), 2, 20);
  assert.equal(levels.length, 2);
  assert.equal(levels[0], 0);
  assert.ok((levels[1] ?? 0) > 7000);
});

test("pcmLevels pads the front when there is less audio than requested", () => {
  const levels = pcmLevels(pcm(new Array(160).fill(1000)), 4, 20);
  assert.equal(levels.length, 4);
  assert.equal(levels[0], 0);
  assert.ok((levels[3] ?? 0) > 0);
});

test("pcmLevels is empty for an empty buffer", () => {
  assert.deepEqual(pcmLevels(Buffer.alloc(0), 4, 20), []);
});

test("normalizeLevel maps silence to 0 and loud input towards 1", () => {
  assert.equal(normalizeLevel(0), 0);
  assert.equal(normalizeLevel(8192), 1);
  assert.equal(normalizeLevel(100000), 1);
  assert.ok(normalizeLevel(2048) > 0.4 && normalizeLevel(2048) < 0.6);
});
