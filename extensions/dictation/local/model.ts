/**
 * Local model lifecycle: status, download, extract, delete.
 *
 * Downloading goes through `curl` when available (it honors HTTP(S)_PROXY from
 * the environment, which Node's fetch does not do unless the process was
 * started with NODE_USE_ENV_PROXY=1), and falls back to a plain fetch stream.
 * Extraction uses the system `tar`, which handles `.tar.bz2` on Linux, macOS
 * and Windows 10+.
 */

import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { archivePathFor, modelDir, localModelSpec, type LocalModelSpec } from "./catalog.ts";
import { findExecutable } from "../audio.ts";

const execFileAsync = promisify(execFile);
const PROGRESS_INTERVAL_MS = 400;

export type ModelState = {
  id: string;
  dir: string;
  ready: boolean;
  missing: string[];
  sizeMb: number;
  label: string;
};

export const modelState = (id: string): ModelState => {
  const spec = localModelSpec(id);
  const dir = modelDir(id);
  if (!spec) return { id, dir, ready: false, missing: [], sizeMb: 0, label: id };

  const missing = spec.files.filter((file) => !existsSync(`${dir}/${file}`));
  return { id, dir, ready: missing.length === 0, missing, sizeMb: spec.sizeMb, label: spec.label };
};

export type DownloadProgress = (message: string, percent: number) => void;

export const downloadModel = async (
  id: string,
  onProgress?: DownloadProgress,
  signal?: AbortSignal,
): Promise<ModelState> => {
  const spec = localModelSpec(id);
  if (!spec) throw new Error(`unknown local model: ${id}`);

  const archive = archivePathFor(spec);
  mkdirSync(archive.slice(0, archive.lastIndexOf("/")), { recursive: true });

  if (!(await usableArchive(archive))) {
    await downloadFile(spec, archive, onProgress, signal);
  }

  if (!(await usableArchive(archive))) {
    throw new Error(`download produced no usable archive at ${archive}`);
  }

  await extractArchive(archive, modelDir(id));
  const state = modelState(id);
  if (!state.ready) {
    const found = await listFiles(modelDir(id));
    throw new Error(`model files missing after extraction (found: ${found.join(", ") || "nothing"}); expected ${spec.files.join(", ")}`);
  }
  return state;
};

export const deleteModel = async (id: string): Promise<{ removed: string[] }> => {
  const spec = localModelSpec(id);
  if (!spec) throw new Error(`unknown local model: ${id}`);
  const removed: string[] = [];
  for (const path of [modelDir(id), archivePathFor(spec)]) {
    if (existsSync(path)) {
      await rm(path, { force: true, recursive: true });
      removed.push(path);
    }
  }
  return { removed };
};

const usableArchive = async (archive: string): Promise<boolean> => {
  try {
    return (await stat(archive)).size > 1024;
  } catch {
    return false;
  }
};

const downloadFile = async (
  spec: LocalModelSpec,
  dest: string,
  onProgress?: DownloadProgress,
  signal?: AbortSignal,
): Promise<void> => {
  const curl = findExecutable("curl");
  const totalBytes = (await probeContentLength(spec.url, curl)) || spec.sizeMb * 1024 * 1024;
  const report = (percent: number, doneBytes: number) => {
    if (!onProgress) return;
    const doneMb = Math.round(doneBytes / 1024 / 1024);
    const totalMb = Math.round(totalBytes / 1024 / 1024);
    onProgress(`${percent}% (${doneMb}/${totalMb} MB)`, percent);
  };

  rmSync(dest, { force: true });

  let timer: NodeJS.Timeout | undefined;
  const watch = setInterval(() => {
    try {
      const size = statSync(dest).size;
      report(Math.min(99, Math.round((size / totalBytes) * 100)), size);
    } catch {
      /* not created yet */
    }
  }, PROGRESS_INTERVAL_MS);
  timer = watch;
  watch.unref?.();

  try {
    if (curl) {
      await execFileAsync(curl, ["-L", "--fail", "--silent", "--show-error", "-o", dest, spec.url], {
        maxBuffer: 1024 * 1024,
        signal,
      });
    } else {
      await fetchToFile(spec.url, dest, signal);
    }
  } finally {
    if (timer) clearInterval(timer);
  }

  const size = statSync(dest).size;
  report(100, size);
};

const fetchToFile = async (url: string, dest: string, signal?: AbortSignal): Promise<void> => {
  const response = await fetch(url, { redirect: "follow", signal });
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
};

const probeContentLength = async (url: string, curl?: string): Promise<number> => {
  if (!curl) return 0;
  try {
    const { stdout } = await execFileAsync(curl, ["-sIL", url], { maxBuffer: 1024 * 1024 });
    const matches = [...stdout.matchAll(/^content-length:\s*(\d+)/gim)];
    const last = matches.at(-1);
    return last ? Number.parseInt(last[1] ?? "0", 10) : 0;
  } catch {
    return 0;
  }
};

const extractArchive = async (archive: string, dest: string): Promise<void> => {
  await mkdir(dest, { recursive: true });
  const tar = systemTar();
  const attempts: string[][] = [
    ["xjf", archive, "-C", dest, "--strip-components=1"],
    ["xjf", archive, "-C", dest, "--strip-components=1", "--overwrite"],
  ];
  let lastError = "";
  for (const args of attempts) {
    try {
      await execFileAsync(tar, args, { maxBuffer: 1024 * 1024 });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`cannot extract ${basename(archive)}: ${lastError} (install bzip2 / GNU tar)`);
};

const systemTar = (): string => {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const candidate = `${systemRoot}\\System32\\tar.exe`;
    if (existsSync(candidate)) return candidate;
  }
  return "tar";
};

const listFiles = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir)).slice(0, 10);
  } catch {
    return [];
  }
};
