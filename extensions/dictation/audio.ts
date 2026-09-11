/**
 * Microphone capture. One code path for every backend: spawn a process that
 * writes raw 16 kHz mono PCM16LE to stdout, then finalize on SIGINT.
 *
 * Why raw PCM on stdout instead of a WAV file written by the tool: ffmpeg keeps
 * a `.wav` output at 0 bytes for the whole recording (it patches the header at
 * the end), so a file-based level meter and timer show nothing until the
 * recording stops. Owning the container here gives real-time levels, an exact
 * elapsed time, and identical behaviour for ffmpeg / pw-record / arecord / sox.
 *
 * Backends are tried in a fixed order by `detectRecorderTool`; `capture.tool`
 * overrides the choice. Every backend finalizes its stream on SIGINT.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdtempSync, openSync, readFileSync, writeSync, closeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { CaptureConfig } from "./config.ts";
import { defaultConfigPath } from "./config.ts";
import { RIFF_HEADER_BYTES, SILENCE_MAX_AMPLITUDE, peakPcm16LeAmplitude } from "./wav.ts";
import { describeSilence, listInputDevices } from "./mic.ts";

export type RecorderTool = "ffmpeg" | "pw-record" | "arecord" | "sox";

export type RecordHandle = {
  outputPath: string;
  tool: RecorderTool;
  /** Finalize the recording and return the WAV path. Throws when the file is too small or silent. */
  stop(): Promise<string>;
  /** Abort and delete the temporary file without validation. */
  cancel(): Promise<void>;
  /** Kill the process and remove the temp directory. Safe to call twice. */
  dispose(): Promise<void>;
  /** Recorded milliseconds so far, from the number of captured PCM bytes. */
  elapsedMs(): number;
  /** Last `bytes` bytes of captured PCM (oldest first), for the level meter. */
  readTail(bytes: number): Buffer;
};

export type Recorder = ReturnType<typeof createRecorder>;

const KILL_GRACE_MS = 3000;
/** Keep enough PCM for a few seconds of meter history without unbounded growth. */
const TAIL_CAPACITY = 64 * 1024;

/**
 * Microphone failures are the ones users cannot fix from the error text alone,
 * so the message also says what the Pi agent should inspect and change.
 * Kept to two lines: the human part of the message stays first.
 */
const captureFixHint = (capture: CaptureConfig): string =>
  `Agent: the microphone capture failed. Check \`capture.tool\` (currently "${capture.tool}") and \`capture.device\` (currently "${capture.device || "auto"}\`) in ${defaultConfigPath()}; ` +
  `list the inputs with \`/dictation mic\`, prefer the system default (or the final virtual) source over a physical device, then ask the user to try dictation again.`;

export const detectRecorderTool = (
  capture: Pick<CaptureConfig, "tool" | "ffmpegPath">,
  env: NodeJS.ProcessEnv = process.env,
): { tool?: RecorderTool; detail: string } => {
  if (capture.tool !== "auto") {
    const wanted = capture.tool as RecorderTool;
    const path = resolveExecutable(capture, wanted, env);
    return path ? { tool: wanted, detail: path } : { detail: `${wanted} not found in PATH` };
  }

  for (const tool of ["ffmpeg", "pw-record", "arecord", "sox"] as RecorderTool[]) {
    const path = resolveExecutable(capture, tool, env);
    if (path) return { tool, detail: path };
  }
  return { detail: "no recorder found (need ffmpeg, pw-record, arecord or sox)" };
};

export type RecorderOptions = {
  /**
   * Called with each chunk of PCM16LE as it arrives, before it reaches the file.
   * Used by streaming dictation to decode while the user is still speaking.
   * Errors here never stop the recording.
   */
  onPcm?: (chunk: Buffer) => void;
};

export const createRecorder = (capture: CaptureConfig, options: RecorderOptions = {}) => ({
  start(): RecordHandle {
    const detected = detectRecorderTool(capture);
    if (!detected.tool) throw new Error(`${detected.detail}. ${captureFixHint(capture)}`);
    const tool = detected.tool;

    const tempDir = mkdtempSync(join(tmpdir(), "pi-dictation-"));
    const outputPath = join(tempDir, "recording.wav");
    const fd = openSync(outputPath, "w");
    writeSync(fd, wavHeader(0, capture));

    const spec = commandFor(tool, capture);
    const child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
    const stderr = captureStderr(child);
    const exited = waitForExit(child);

    let pcmTail = Buffer.alloc(0);
    let captured = 0;
    let stopped = false;
    let disposed = false;
    let fileClosed = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (fileClosed) return;
      captured += chunk.length;
      try {
        writeSync(fd, chunk);
      } catch {
        return;
      }
      pcmTail =
        pcmTail.length + chunk.length > TAIL_CAPACITY ? Buffer.concat([pcmTail, chunk]).subarray(-TAIL_CAPACITY) : Buffer.concat([pcmTail, chunk]);
      try {
        options.onPcm?.(chunk);
      } catch {
        /* a listener must not be able to kill the recording */
      }
    });
    child.stdout?.on("error", () => {
      /* process died; stop() reports it */
    });

    const signal = (sig: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    };

    const finalize = () => {
      if (stopped) return;
      stopped = true;
      // Windows ffmpeg quits cleanly with "q" on stdin; SIGINT is not delivered.
      if (process.platform === "win32" && child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write("q\n");
        child.stdin.end();
        return;
      }
      signal("SIGINT");
      setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS).unref?.();
    };

    const closeFile = () => {
      if (fileClosed) return;
      fileClosed = true;
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    };

    const patchHeader = () => {
      try {
        const patch = openSync(outputPath, "r+");
        writeSync(patch, wavHeader(captured, capture), 0, RIFF_HEADER_BYTES, 0);
        closeSync(patch);
      } catch {
        /* best effort: the audio tail is still readable for most tools */
      }
    };

    const cleanupTemp = async () => {
      closeFile();
      await rm(tempDir, { force: true, recursive: true }).catch(() => {});
    };

    return {
      outputPath,
      tool,
      elapsedMs(): number {
        const bytesPerSecond = capture.sampleRate * capture.channels * 2;
        return bytesPerSecond > 0 ? Math.round((captured / bytesPerSecond) * 1000) : 0;
      },
      readTail(bytes: number): Buffer {
        return bytes >= pcmTail.length ? pcmTail : pcmTail.subarray(pcmTail.length - bytes);
      },
      async stop() {
        finalize();
        await exited;
        closeFile();
        patchHeader();
        await assertUsableAudio(outputPath, capture, captured, stderr());
        return outputPath;
      },
      async cancel() {
        finalize();
        signal("SIGKILL");
        await exited;
        await cleanupTemp();
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        finalize();
        signal("SIGKILL");
        await exited;
        await cleanupTemp();
      },
    };
  },
});

/** A 44-byte PCM16LE mono/stereo WAV header. Sizes are patched once recording stops. */
export const wavHeader = (dataBytes: number, capture: Pick<CaptureConfig, "sampleRate" | "channels">): Buffer => {
  const header = Buffer.alloc(RIFF_HEADER_BYTES);
  const blockAlign = capture.channels * 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(capture.channels, 22);
  header.writeUInt32LE(capture.sampleRate, 24);
  header.writeUInt32LE(capture.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
};

/** The argv for one recording backend, kept pure so it can be unit-tested. */
export const commandFor = (tool: RecorderTool, capture: CaptureConfig): { command: string; args: string[] } => {
  const rate = String(capture.sampleRate);
  const channels = String(capture.channels);
  const device = capture.device.trim();

  if (tool === "ffmpeg") {
    const platform = process.platform;
    const inputFormat = platform === "darwin" ? "avfoundation" : platform === "win32" ? "dshow" : "pulse";
    const fallbackInput = platform === "darwin" ? ":0" : "default";
    return {
      command: capture.ffmpegPath || "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        inputFormat,
        ...(inputFormat === "dshow" ? ["-audio_buffer_size", "20"] : []),
        "-i",
        device || fallbackInput,
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        rate,
        "-ac",
        channels,
        "-f",
        "s16le",
        "-",
      ],
    };
  }

  if (tool === "pw-record") {
    return {
      command: "pw-record",
      args: [`--rate=${rate}`, `--channels=${channels}`, "--format=s16", ...(device ? [`--target=${device}`] : []), "-"],
    };
  }

  if (tool === "arecord") {
    return {
      command: "arecord",
      args: ["-f", "S16_LE", "-r", rate, "-c", channels, "-t", "raw", "-D", device || "default", "-"],
    };
  }

  // sox records from the default device; device selection is env-specific.
  return { command: "sox", args: ["-d", "-r", rate, "-c", channels, "-b", "16", "-t", "raw", "-"] };
};

const assertUsableAudio = async (outputPath: string, capture: CaptureConfig, captured: number, stderr: string): Promise<void> => {
  if (captured < capture.minBytes) {
    throw new Error(`recording is empty (${captured} bytes) — check the microphone device and permission. ${tail(stderr)} ${captureFixHint(capture)}`);
  }
  const peak = peakPcm16LeAmplitude(readFileSync(outputPath));
  if (peak === undefined || peak > SILENCE_MAX_AMPLITUDE) return;

  // Digital silence: name the device and the alternative, instead of only
  // reporting "silent". This is the failure users actually hit (wireless mic
  // with its transmitter off, suspended monitor source).
  const report = await listInputDevices();
  const detail = describeSilence({ ...report, peak });
  throw new Error(`recording is silent (peak ${peak}) — ${detail}. ${tail(stderr)} ${captureFixHint(capture)}`.trim());
};

const captureStderr = (child: ChildProcess): (() => string) => {
  let text = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    text = (text + chunk).slice(-4096);
  });
  return () => text;
};

const waitForExit = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });

const tail = (value: string): string => value.trim().replace(/\s+/g, " ").slice(-240);

export const resolveExecutable = (
  capture: Pick<CaptureConfig, "ffmpegPath">,
  tool: RecorderTool,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  if (tool === "ffmpeg") return findExecutable(capture.ffmpegPath || "ffmpeg", env);
  return findExecutable(tool, env);
};

/** PATH lookup without a shell: returns the first executable match. */
export const findExecutable = (name: string, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  if (!name) return undefined;
  if (name.includes("/") || name.includes("\\")) return isExecutable(name) ? name : undefined;

  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension.toLowerCase()}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
};

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
