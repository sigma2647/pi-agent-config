/**
 * SenseVoice: one int8 ONNX file plus a token table, decoded in one pass.
 *
 * It emits punctuation and inverse-text-normalized numbers itself, which is why
 * it is the default offline family.
 */

import { join } from "node:path";
import { specFile, weightsAndTokens, type LocalFamily } from "./types.ts";

export const senseVoiceFamily: LocalFamily = {
  id: "sense-voice",
  files: weightsAndTokens,
  offline: (spec, dir) => ({
    senseVoice: {
      model: join(dir, specFile(spec, "weights")),
      language: "",
      useInverseTextNormalization: 1,
    },
    tokens: join(dir, specFile(spec, "tokens")),
  }),
};
