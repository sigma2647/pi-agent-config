/** Speech-to-text provider contract. One file per vendor, one registration. */

export type TranscribeInput = {
  audioPath: string;
  /** Provider hint; undefined means "auto-detect". */
  language?: string;
  signal: AbortSignal;
};

export type TranscribeResult = {
  text: string;
};

export type SttProvider = {
  id: string;
  /** Shown in status output. */
  label: string;
  kind: "local" | "cloud";
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
};

/** Trim a configured language; empty and "auto" mean "let the provider detect". */
export const normalizeLanguage = (language?: string): string | undefined => {
  const trimmed = (language ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") return undefined;
  return trimmed;
};

export const formatError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
};

export const truncate = (value: string, length = 300): string => (value.length <= length ? value : `${value.slice(0, length)}…`);
