/**
 * One sherpa-onnx model family.
 *
 * The split keeps each kind of knowledge in one place:
 *   - `local/catalog.ts` is data: which model, which files, where to get it;
 *   - a family in this directory is code: how those files become a recognizer.
 *
 * Adding a family = one file here + one line in `index.ts`. No dispatcher, and
 * no `if/else` chain anywhere else in the extension, has to change.
 */

import type { LocalModelSpec } from "../catalog.ts";

export type LocalFamily = {
  /** Matches `LocalModelSpec.family`; `sense-voice` is the default. */
  id: string;
  /** Files a usable model directory must contain, in the order errors name them. */
  files: (spec: LocalModelSpec) => string[];
  /** Whole-utterance decode: the text arrives once the recording has stopped. */
  offline?: (spec: LocalModelSpec, dir: string) => Record<string, unknown>;
  /** Live decode: text appears while the user is still speaking. */
  online?: (spec: LocalModelSpec, dir: string) => Record<string, unknown>;
};

/**
 * File names live in the catalog, so a family reads them instead of hard-coding
 * them twice — and a catalog that forgets one says which entry is broken.
 */
export const specFile = (spec: LocalModelSpec, key: "weights" | "tokens" | "encoder" | "decoder" | "joiner"): string => {
  const file = spec[key];
  if (!file) throw new Error(`local model ${spec.id} is missing its "${key}" file entry in the catalog`);
  return file;
};

/** The common layout: one ONNX weights file plus a token table. */
export const weightsAndTokens = (spec: LocalModelSpec): string[] => [specFile(spec, "weights"), specFile(spec, "tokens")];
