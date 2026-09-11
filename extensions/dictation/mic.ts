/**
 * Microphone diagnostics.
 *
 * The most common real-world failure is not a missing recorder but a device
 * that delivers digital silence: a wireless mic whose transmitter is off, or a
 * suspended monitor source. The recording then fails with "silent", which is
 * technically correct and completely unhelpful. These helpers turn that into
 * "your default source is X, which is not muted but produced only zeros; here
 * are the other inputs you can switch to".
 *
 * Linux/PipeWire+PulseAudio only (`pactl`); on other platforms the helpers
 * return an empty result and the caller keeps the plain message.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CaptureConfig } from "./config.ts";
import { createRecorder } from "./audio.ts";
import { peakRawPcm16Le } from "./wav.ts";
import { findExecutable } from "./audio.ts";

const execFileAsync = promisify(execFile);

export type InputDevice = {
  name: string;
  description: string;
  isDefault: boolean;
};

export type InputDeviceReport = {
  defaultSource: string;
  devices: InputDevice[];
  /** Set when the device list could not be read. */
  warning?: string;
};

/** Parse `pactl list short sources` output. Monitor sources are not inputs. */
export const parsePactlSources = (output: string, defaultSource: string): InputDevice[] =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const columns = line.split(/\s+/);
      const name = columns[1] ?? "";
      return { name, description: columns.slice(2).join(" "), isDefault: name === defaultSource };
    })
    .filter((device) => device.name.length > 0 && !device.name.endsWith(".monitor"));

export const listInputDevices = async (env: NodeJS.ProcessEnv = process.env): Promise<InputDeviceReport> => {
  if (process.platform !== "linux" || !findExecutable("pactl", env)) {
    return { defaultSource: "", devices: [] };
  }

  const run = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync("pactl", args, { timeout: 4000, maxBuffer: 1024 * 1024 });
      return stdout;
    } catch {
      return "";
    }
  };

  const [sources, defaultSource] = await Promise.all([run(["list", "short", "sources"]), run(["get-default-source"])]);
  if (!sources.trim()) {
    return { defaultSource: "", devices: [], warning: "pactl is installed but returned no audio sources" };
  }
  return { defaultSource: defaultSource.trim(), devices: parsePactlSources(sources, defaultSource.trim()) };
};

export type MicProbe = {
  peak: number;
  bytes: number;
  defaultSource: string;
  devices: InputDevice[];
  warning?: string;
};

/**
 * Record `ms` milliseconds and report the loudest sample. Uses the recorder, so
 * it validates exactly the path dictation uses — and it never throws on silence,
 * because silence is the thing being measured.
 */
export const probeMic = async (capture: CaptureConfig, ms = 400): Promise<MicProbe> => {
  const report = await listInputDevices();
  let handle;
  try {
    handle = createRecorder(capture).start();
  } catch (error) {
    return { peak: 0, bytes: 0, ...report, warning: error instanceof Error ? error.message : String(error) };
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, ms));
    const pcm = handle.readTail(256 * 1024);
    return { peak: peakRawPcm16Le(pcm), bytes: pcm.length, ...report };
  } finally {
    await handle.cancel().catch(() => {});
  }
};

/** One actionable sentence for a silent recording, used in error messages and doctor output. */
export const describeSilence = (probe: Pick<MicProbe, "defaultSource" | "devices" | "peak">): string => {
  const others = probe.devices.filter((device) => !device.isDefault);
  const parts: string[] = [];
  if (probe.defaultSource) parts.push(`default input "${probe.defaultSource}" produced only zeros (peak ${probe.peak})`);
  if (others.length === 0) {
    parts.push("no other input device is available");
    return parts.join("; ");
  }
  parts.push(`other inputs: ${others.map((device) => device.name).join(", ")}`);
  parts.push(`switch with: pactl set-default-source <name>, or set capture.device in the config`);
  return parts.join("; ");
};
