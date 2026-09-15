/**
 * FireRedASR2 CTC: one int8 ONNX file plus a token table.
 *
 * Same file layout as SenseVoice, different decoder — and it does not emit
 * punctuation, so its transcripts come back without commas or full stops.
 */

import { join } from "node:path";
import { specFile, weightsAndTokens, type LocalFamily } from "./types.ts";

export const fireRedAsrCtcFamily: LocalFamily = {
  id: "fire-red-asr-ctc",
  files: weightsAndTokens,
  offline: (spec, dir) => ({
    fireRedAsrCtc: {
      model: join(dir, specFile(spec, "weights")),
    },
    tokens: join(dir, specFile(spec, "tokens")),
  }),
};
