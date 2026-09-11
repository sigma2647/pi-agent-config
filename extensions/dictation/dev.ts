#!/usr/bin/env -S NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings
/**
 * `pi-dictation` CLI — the same engine as the pi extension, without the TUI.
 *
 *   pi-dictation transcribe <file> [--provider id] [--language zh] [--json]
 *   pi-dictation record [--seconds N] [--provider id]     (Enter stops early)
 *   pi-dictation model [status|download|delete|path] [id]
 *   pi-dictation providers
 *   pi-dictation doctor
 *   pi-dictation config
 *
 * Exit code 0 = success, 1 = failure (the message says what to do next).
 */

import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { createRecorder } from "./audio.ts";
import { defaultConfigPath, ensureConfigFile, loadConfig, redactConfig, type DictationConfig } from "./config.ts";
import { doctorReport, formatTranscript, micDiagnostics, transcribeFile } from "./core.ts";
import { decodeKeyEvents, keytestVerdict, parseKittyFlags, type DecodedKey } from "./keyprobe.ts";
import { DEFAULT_LOCAL_MODEL, knownModelIds, localModelSpec } from "./local/catalog.ts";
import { deleteModel, downloadModel, modelState } from "./local/model.ts";
import { providerStatuses, resolveProvider } from "./providers/index.ts";

type Flags = {
  provider?: string;
  language?: string;
  seconds?: number;
  json: boolean;
  positional: string[];
};

const parseFlags = (argv: string[]): Flags => {
  const flags: Flags = { json: false, positional: [] };
  const value = (index: number, arg: string, name: string): string | undefined => {
    if (arg === `--${name}`) return argv[index + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
    return undefined;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    let matched = false;
    for (const name of ["provider", "language", "seconds"] as const) {
      const raw = value(index, arg, name);
      if (raw === undefined) continue;
      matched = true;
      if (arg === `--${name}`) index += 1;
      if (name === "seconds") flags.seconds = Number.parseInt(raw, 10);
      else flags[name] = raw;
      break;
    }
    if (!matched) flags.positional.push(arg);
  }
  return flags;
};

const USAGE = `pi-dictation — speech-to-text for pi (local SenseVoice model or cloud API)

Usage:
  pi-dictation transcribe <file> [--provider <id>] [--language <code>] [--json]
  pi-dictation record [--seconds <n>] [--provider <id>]
  pi-dictation model [status|download|delete|path] [<model-id>]
  pi-dictation providers
  pi-dictation doctor
  pi-dictation mic                       sample the microphone and list inputs
  pi-dictation keytest [--seconds <n>]   show what keys your terminal really sends
  pi-dictation config

Config: ${defaultConfigPath()}  (env overrides: PI_DICTATION_PROVIDER, PI_DICTATION_KEYBIND, PI_DICTATION_KEYBIND_MODE, PI_DICTATION_LOCALE, PI_DICTATION_CONFIG)
`;

const main = async (): Promise<number> => {
  const [command = "help", ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const config = loadConfig();

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    case "transcribe":
      return transcribeCommand(config, flags);
    case "record":
      return recordCommand(config, flags);
    case "model":
      return modelCommand(flags);
    case "providers":
      return providersCommand(config, flags.json);
    case "doctor":
      return await doctorCommand(config, flags.json);
    case "mic":
      return await micCommand(config, flags.json);
    case "keytest":
      return await keytestCommand(flags.seconds);
    case "config":
      return configCommand(config, flags.json);
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
};

const transcribeCommand = async (config: DictationConfig, flags: Flags): Promise<number> => {
  const file = flags.positional[0];
  if (!file) {
    process.stderr.write("transcribe needs an audio file path\n");
    return 1;
  }
  if (!existsSync(file)) {
    process.stderr.write(`file not found: ${file}\n`);
    return 1;
  }
  const outcome = await transcribeFile({
    config,
    audioPath: file,
    language: flags.language,
    providerId: flags.provider,
  });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ text: outcome.text, provider: outcome.providerId, file }, null, 2)}\n`);
  } else {
    process.stdout.write(`${outcome.text}\n`);
    process.stderr.write(`— ${outcome.providerId} (${outcome.providerLabel})\n`);
  }
  return 0;
};

const recordCommand = async (config: DictationConfig, flags: Flags): Promise<number> => {
  const seconds = Number.isFinite(flags.seconds) && (flags.seconds ?? 0) > 0 ? Math.min(600, flags.seconds!) : 0;
  const handle = createRecorder(config.capture).start();

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on("SIGINT", () => {
    void handle.cancel().then(() => process.exit(130));
  });

  process.stderr.write(seconds ? `recording ${seconds}s…\n` : "recording — press Enter to stop\n");
  // Stop on Enter, on EOF (piped stdin), or after `--seconds`, whichever comes first.
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    if (seconds) {
      const timer = setTimeout(finish, seconds * 1000);
      timer.unref?.();
    }
    rl.once("line", finish);
    rl.once("close", finish);
  });
  rl.close();

  const audioPath = await handle.stop();
  try {
    const outcome = await transcribeFile({
      config,
      audioPath,
      language: flags.language,
      providerId: flags.provider,
    });
    process.stdout.write(`${formatTranscript(outcome.text, config.output).trimEnd()}\n`);
    process.stderr.write(`— ${outcome.providerId} (${outcome.providerLabel})\n`);
    return outcome.text.trim() ? 0 : 1;
  } finally {
    await handle.dispose();
  }
};

const modelCommand = async (flags: Flags): Promise<number> => {
  const [sub = "status", id = DEFAULT_LOCAL_MODEL] = flags.positional;
  if (sub === "download") {
    const state = modelState(id);
    if (state.ready) {
      process.stdout.write(`${id} already downloaded at ${state.dir}\n`);
      return 0;
    }
    process.stderr.write(`downloading ${id} (~${state.sizeMb} MB)…\n`);
    await downloadModel(id, (message) => process.stderr.write(`\r${message.padEnd(40)}`));
    process.stderr.write("\n");
    process.stdout.write(`${id} ready at ${modelState(id).dir}\n`);
    return 0;
  }
  if (sub === "delete") {
    const { removed } = await deleteModel(id);
    process.stdout.write(removed.length ? `removed:\n${removed.join("\n")}\n` : `${id} is not downloaded\n`);
    return 0;
  }
  if (sub === "path") {
    process.stdout.write(`${modelState(id).dir}\n`);
    return 0;
  }
  for (const modelId of knownModelIds()) {
    const spec = localModelSpec(modelId);
    const state = modelState(modelId);
    process.stdout.write(`${state.ready ? "✓" : "✗"} ${modelId} — ${spec?.label ?? ""} · ${spec?.languages ?? ""} · ≈${spec?.sizeMb ?? 0} MB\n  ${state.dir}\n`);
  }
  return 0;
};

const providersCommand = (config: DictationConfig, json: boolean): number => {
  const statuses = providerStatuses(config);
  const resolved = resolveProvider(config);
  if (json) {
    process.stdout.write(`${JSON.stringify({ configured: config.provider, selected: resolved?.id ?? null, providers: statuses }, null, 2)}\n`);
    return 0;
  }
  for (const status of statuses) {
    process.stdout.write(`${status.ready ? "✓" : "✗"} ${status.id} [${status.kind}] — ${status.detail}\n`);
  }
  process.stdout.write(`\nselected: ${resolved ? resolved.id : "none"}${resolved ? ` (${resolved.reason})` : ""}\n`);
  return resolved ? 0 : 1;
};

const doctorCommand = async (config: DictationConfig, json: boolean): Promise<number> => {
  const report = doctorReport(config);
  // A 400 ms microphone sample: silence is the failure users actually hit, and
  // it is invisible to static checks.
  const mic = await micDiagnostics(config);
  const lines = [...report.lines, ...mic];
  const ok = report.ok && mic.every((line) => line.level !== "fail");

  if (json) {
    process.stdout.write(`${JSON.stringify({ ...report, ok, lines }, null, 2)}\n`);
    return ok ? 0 : 1;
  }
  const icon: Record<string, string> = { ok: "✓", warn: "!", fail: "✗" };
  for (const line of lines) process.stdout.write(`${icon[line.level]} ${line.text}\n`);
  process.stdout.write(`\n${ok ? "ready" : "not ready"}\n`);
  return ok ? 0 : 1;
};

const micCommand = async (config: DictationConfig, json: boolean): Promise<number> => {
  const lines = await micDiagnostics(config, 800);
  if (json) {
    process.stdout.write(`${JSON.stringify(lines, null, 2)}\n`);
  } else {
    const icon: Record<string, string> = { ok: "✓", warn: "!", fail: "✗" };
    for (const line of lines) process.stdout.write(`${icon[line.level]} ${line.text}\n`);
  }
  return lines.some((line) => line.level !== "ok") ? 1 : 0;
};

/**
 * `keytest` — ask the terminal for the Kitty keyboard protocol flags, then echo
 * every key event so the user can see whether releases are reported (which is
 * what hold-to-talk needs). Interactive terminals only.
 */
const keytestCommand = async (seconds?: number): Promise<number> => {
  if (!process.stdin.isTTY) {
    process.stderr.write("keytest needs a real terminal (stdin is not a TTY). Run it directly in ghostty.\n");
    return 1;
  }
  const durationMs = Number.isFinite(seconds) && (seconds ?? 0) > 0 ? Math.min(60, seconds!) * 1000 : 10_000;

  process.stderr.write(
    `按几次 ctrl+r（含一次按住 1 秒再松开），${Math.round(durationMs / 1000)} 秒后结束。按 Esc 立即结束。\n`,
  );

  const events: DecodedKey[] = [];
  let flags: number | undefined;
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  // Ask the terminal to report the Kitty keyboard protocol flags it supports.
  process.stdout.write("\x1b[>7u\x1b[?u");

  const onData = (chunk: string): void => {
    const parsedFlags = parseKittyFlags(chunk);
    if (parsedFlags !== undefined) {
      flags = parsedFlags;
      process.stderr.write(`键盘协议 flags=${flags}（bit2 上报松开事件：${(flags & 2) !== 0 ? "支持" : "不支持"}）\n`);
      return;
    }
    for (const event of decodeKeyEvents(chunk)) {
      events.push(event);
      const hex = [...event.raw].map((char) => char.codePointAt(0)!.toString(16).padStart(2, "0")).join(" ");
      process.stderr.write(`  ${event.label} [${event.type}]  0x ${hex}\n`);
    }
  };

  const finish = (): void => {
    stdin.removeListener("data", onData);
    stdin.setRawMode?.(wasRaw ?? false);
    stdin.pause();
    const verdict = keytestVerdict(events, flags);
    process.stderr.write(`\n=> ${verdict.text}\n`);
  };

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    stdin.on("data", (chunk: string | Buffer) => {
      const text = chunk.toString();
      if (text.includes("\u001b") && decodeKeyEvents(text).some((event) => event.label === "escape")) {
        clearTimeout(timer);
        resolve();
        return;
      }
      onData(text);
    });
  });
  finish();
  return 0;
};

const configCommand = (config: DictationConfig, json: boolean): number => {
  const path = defaultConfigPath();
  ensureConfigFile(path);
  process.stdout.write(`${path}\n`);
  process.stdout.write(`${JSON.stringify(redactConfig(config), null, json ? 2 : 2)}\n`);
  return 0;
};

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
