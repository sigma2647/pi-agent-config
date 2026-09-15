/**
 * Streaming zipformer transducer: encoder + decoder + joiner + token table.
 *
 * The only family that decodes while the user is still speaking, so it is the
 * only one an `online` config exists for.
 */

import { join } from "node:path";
import { specFile, type LocalFamily } from "./types.ts";

export const streamingZipformerFamily: LocalFamily = {
  id: "streaming-zipformer",
  files: (spec) => [specFile(spec, "encoder"), specFile(spec, "decoder"), specFile(spec, "joiner"), specFile(spec, "tokens")],
  online: (spec, dir) => ({
    transducer: {
      encoder: join(dir, specFile(spec, "encoder")),
      decoder: join(dir, specFile(spec, "decoder")),
      joiner: join(dir, specFile(spec, "joiner")),
    },
    tokens: join(dir, specFile(spec, "tokens")),
  }),
};
