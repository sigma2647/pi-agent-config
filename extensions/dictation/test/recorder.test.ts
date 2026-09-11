/**
 * Recorder contract tests with a fake capture tool.
 *
 * The fake tool mimics what ffmpeg/arecord/sox do for us: stream 16 kHz mono
 * PCM16 on stdout, then stop when the process receives SIGINT. That covers the
 * behaviours that are easy to break: the SIGINT finalize step, the live meter
 * and timer, the "recording too small" check, and the silence check.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandFor, createRecorder } from "../audio.ts";
import { DEFAULT_CONFIG, mergeConfig } from "../config.ts";
import { pcmLevels, peakPcm16LeAmplitude } from "../wav.ts";

const FAKE_TOOL = `#!/usr/bin/env node
const silent = process.env.FAKE_SILENT === "1";
const samples = Number(process.env.FAKE_SAMPLES ?? "32000");
const data = Buffer.alloc(samples * 2);
for (let i = 0; i < samples; i += 1) data.writeInt16LE(silent ? 0 : 6000, i * 2);
process.stdout.write(data);
process.on("SIGINT", () => process.exit(0));
setInterval(() => {}, 200);
`;

const setup = (env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dictation-fake-"));
  const tool = join(dir, "ffmpeg");
  writeFileSync(tool, FAKE_TOOL);
  chmodSync(tool, 0o755);
  const previous = { ...process.env };
  // Keep the real PATH so the fake tool's own interpreter (node) resolves.
  Object.assign(process.env, { PATH: `${dir}:${previous.PATH ?? ""}`, ...env });
  const config = mergeConfig(DEFAULT_CONFIG, { capture: { tool: "ffmpeg", ffmpegPath: tool } });
  return {
    config,
    restore: () => {
      process.env = previous;
    },
  };
};

test("commandFor streams raw PCM on stdout instead of writing a WAV file", () => {
  const { command, args } = commandFor("ffmpeg", DEFAULT_CONFIG.capture);
  assert.equal(command, "ffmpeg");
  assert.equal(args.at(-1), "-", "output goes to stdout so the meter can read it live");
  assert.ok(args.includes("-ar") && args[args.indexOf("-ar") + 1] === "16000");
  assert.ok(args.includes("-ac") && args[args.indexOf("-ac") + 1] === "1");
  assert.ok(args.includes("pcm_s16le"));
  assert.ok(args.includes("-f") && args[args.indexOf("-f", args.indexOf("-ac")) + 1] === "s16le");
});

test("commandFor covers every backend without a shell", () => {
  for (const tool of ["pw-record", "arecord", "sox"] as const) {
    const { command, args } = commandFor(tool, DEFAULT_CONFIG.capture);
    assert.equal(command, tool);
    assert.equal(args.at(-1), "-", `${tool} must write to stdout`);
    assert.ok(args.every((arg) => !arg.includes(" ")), `${tool} args must be single tokens`);
  }
});

test("recorder reports live elapsed time and levels, then writes a playable WAV", async () => {
  const { config, restore } = setup();
  const handle = createRecorder(config.capture).start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.ok(handle.elapsedMs() >= 200, `elapsed should track captured PCM live (got ${handle.elapsedMs()})`);
    const tail = handle.readTail(4000);
    assert.ok(tail.length > 0, "the level meter reads the live PCM stream");
    assert.ok((pcmLevels(tail, 4, 20)[0] ?? 0) > 0, "the live tail is real PCM, not silence");

    const path = await handle.stop();
    assert.ok(existsSync(path));
    const audio = await import("node:fs/promises").then((fs) => fs.readFile(path));
    assert.equal(audio.toString("ascii", 0, 4), "RIFF");
    assert.equal(audio.readUInt32LE(40), audio.length - 44, "the WAV header is patched with the real data size");
    assert.ok((peakPcm16LeAmplitude(audio) ?? 0) > 1000, "audio survives finalize");
    assert.ok(handle.elapsedMs() >= 250);
  } finally {
    await handle.dispose().catch(() => {});
    restore();
  }
});

test("recorder rejects a silent recording with an actionable message", async () => {
  const { config, restore } = setup({ FAKE_SILENT: "1" });
  const handle = createRecorder(config.capture).start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(() => handle.stop(), /silent/);
  } finally {
    await handle.dispose().catch(() => {});
    restore();
  }
});

test("recorder exposes its tool name for status output", async () => {
  const { config, restore } = setup();
  const handle = createRecorder(config.capture).start();
  try {
    assert.equal(handle.tool, "ffmpeg");
  } finally {
    await handle.dispose().catch(() => {});
    restore();
  }
});

test("recorder rejects a recording below the minimum size", async () => {
  const { config, restore } = setup({ FAKE_SAMPLES: "4" });
  const handle = createRecorder(config.capture).start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(() => handle.stop(), /empty/);
  } finally {
    await handle.dispose().catch(() => {});
    restore();
  }
});

test("cancel removes the temporary file and does not throw", async () => {
  const { config, restore } = setup();
  const handle = createRecorder(config.capture).start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const path = handle.outputPath;
    await handle.cancel();
    assert.equal(existsSync(path), false, "temp file removed");
  } finally {
    await handle.dispose().catch(() => {});
    restore();
  }
});

test("the onPcm listener sees every chunk that reaches the file", async () => {
  const { config, restore } = setup();
  const chunks: Buffer[] = [];
  const handle = createRecorder(config.capture, { onPcm: (chunk) => chunks.push(chunk) }).start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const path = await handle.stop();
    const audio = await import("node:fs/promises").then((fs) => fs.readFile(path));
    const streamed = Buffer.concat(chunks);
    assert.ok(streamed.length > 0, "streaming dictation needs the audio while recording");
    // The WAV file is the header plus exactly the streamed PCM.
    assert.deepEqual(streamed, audio.subarray(44));
  } finally {
    await handle.dispose().catch(() => {});
    restore();
  }
});

test("a throwing onPcm listener does not kill the recording", async () => {
  const { config, restore } = setup();
  const handle = createRecorder(config.capture, {
    onPcm: () => {
      throw new Error("listener exploded");
    },
  }).start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const path = await handle.stop();
    assert.ok(existsSync(path), "the recording still finished");
  } finally {
    await handle.dispose().catch(() => {});
    restore();
  }
});
