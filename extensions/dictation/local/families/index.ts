/**
 * The only list of sherpa-onnx model families.
 *
 * The record is keyed by `LocalModelSpec["family"]`, so adding a family to the
 * type without registering it here is a compile error — the catalogue and the
 * code cannot drift apart silently.
 */

import type { LocalModelSpec } from "../catalog.ts";
import { fireRedAsrCtcFamily } from "./fire-red-asr-ctc.ts";
import { funAsrNanoFamily } from "./fun-asr-nano.ts";
import { senseVoiceFamily } from "./sense-voice.ts";
import { streamingZipformerFamily } from "./streaming-zipformer.ts";
import type { LocalFamily } from "./types.ts";

export type LocalFamilyId = NonNullable<LocalModelSpec["family"]>;

export const LOCAL_FAMILIES: Record<LocalFamilyId, LocalFamily> = {
  "sense-voice": senseVoiceFamily,
  "fire-red-asr-ctc": fireRedAsrCtcFamily,
  "fun-asr-nano": funAsrNanoFamily,
  "streaming-zipformer": streamingZipformerFamily,
};

export const DEFAULT_FAMILY: LocalFamilyId = "sense-voice";

/** The family a catalog entry is written in. */
export const localFamily = (spec: LocalModelSpec): LocalFamily => LOCAL_FAMILIES[spec.family ?? DEFAULT_FAMILY];

export type { LocalFamily } from "./types.ts";
