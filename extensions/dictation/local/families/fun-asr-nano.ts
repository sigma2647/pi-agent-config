/**
 * Fun-ASR-Nano: three int8 ONNX files plus a Qwen3-0.6B tokenizer directory.
 *
 * A SenseVoice encoder feeding a Qwen3-0.6B decoder, so it is the one model
 * here that is both small and measured to handle whispered Chinese — see
 * `docs/asr-model-selection.md` §11 for the numbers.
 *
 * Unlike the other offline families this one has no `tokens` table: sherpa-onnx
 * reads the sub-word vocabulary from the tokenizer *directory* instead.
 */

import { join } from "node:path";
import { specFile, type LocalFamily } from "./types.ts";

export const funAsrNanoFamily: LocalFamily = {
  id: "fun-asr-nano",
  files: (spec) => [
    specFile(spec, "encoderAdaptor"),
    specFile(spec, "llm"),
    specFile(spec, "embedding"),
    specFile(spec, "tokenizer"),
  ],
  offline: (spec, dir) => ({
    funasrNano: {
      encoderAdaptor: join(dir, specFile(spec, "encoderAdaptor")),
      llm: join(dir, specFile(spec, "llm")),
      embedding: join(dir, specFile(spec, "embedding")),
      tokenizer: join(dir, specFile(spec, "tokenizer")),
    },
  }),
};
