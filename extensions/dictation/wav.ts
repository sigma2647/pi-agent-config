/**
 * Pure PCM16/WAV helpers. No I/O, no UI — everything here is unit-testable.
 *
 * The recorder always writes 16 kHz mono 16-bit little-endian PCM, so the
 * parsers assume that format and only guard against "not a WAV yet".
 */

export const RIFF_HEADER_BYTES = 44;

/** Peak absolute sample value in the first `data` chunk, or undefined if unparseable. */
export const peakPcm16LeAmplitude = (audio: Buffer): number | undefined => {
  const data = dataChunk(audio);
  if (!data) return undefined;
  let max = 0;
  for (let index = data.start; index + 1 < data.end; index += 2) {
    const sample = Math.abs(audio.readInt16LE(index));
    if (sample > max) max = sample;
  }
  return max;
};

/**
 * Peak amplitudes at or below this are digital silence, not quiet audio.
 * A real microphone (even with room noise) peaks far above it; a virtual or
 * unselected device records all zeros.
 */
export const SILENCE_MAX_AMPLITUDE = 3;

/** Recorded duration in milliseconds, derived from the PCM payload size. */
export const pcm16DurationMs = (audio: Buffer, sampleRate = 16000, channels = 1): number => {
  const data = dataChunk(audio);
  if (!data) return 0;
  const bytesPerSecond = sampleRate * channels * 2;
  if (bytesPerSecond <= 0) return 0;
  return Math.max(0, Math.round(((data.end - data.start) / bytesPerSecond) * 1000));
};

/** Peak absolute sample value in a raw PCM16LE buffer (no WAV header). */
export const peakRawPcm16Le = (pcm: Buffer): number => {
  let max = 0;
  for (let index = 0; index + 1 < pcm.length; index += 2) {
    const sample = Math.abs(pcm.readInt16LE(index));
    if (sample > max) max = sample;
  }
  return max;
};

/**
 * Root-mean-square level per slice over a raw PCM16LE buffer (no WAV header),
 * used for the live meter: the recorder's file is read from its tail.
 * Returns `slices` values in 0..32768, oldest first.
 */
export const pcmLevels = (pcm: Buffer, slices: number, sliceMs: number, sampleRate = 16000): number[] => {
  if (slices <= 0 || pcm.length < 2) return [];

  const bytesPerSlice = Math.max(2, Math.round((sampleRate * 2 * sliceMs) / 1000) & ~1);
  // Right-align: the newest audio sits at the end, silence pads the front.
  const origin = pcm.length - bytesPerSlice * slices;
  const levels: number[] = [];
  for (let index = 0; index < slices; index += 1) {
    const sliceStart = origin + index * bytesPerSlice;
    const start = Math.max(0, sliceStart);
    const end = Math.min(pcm.length, sliceStart + bytesPerSlice);
    levels.push(end - start < 2 ? 0 : rms(pcm, start, end));
  }
  return levels;
};

/** Normalize a raw RMS value (0..32768) into a 0..1 display level with mild compression. */
export const normalizeLevel = (rmsValue: number): number => {
  const ratio = Math.min(1, Math.max(0, rmsValue / 8192));
  return Math.sqrt(ratio);
};

const rms = (audio: Buffer, start: number, end: number): number => {
  let sum = 0;
  let count = 0;
  for (let index = start; index + 1 < end; index += 2) {
    const sample = audio.readInt16LE(index) / 32768;
    sum += sample * sample;
    count += 1;
  }
  if (count === 0) return 0;
  return Math.sqrt(sum / count) * 32768;
};

const dataChunk = (audio: Buffer): { start: number; end: number } | undefined => {
  if (audio.length < RIFF_HEADER_BYTES) return undefined;
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") return undefined;

  let offset = 12;
  while (offset + 8 <= audio.length) {
    const chunkId = audio.toString("ascii", offset, offset + 4);
    const chunkSize = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + chunkSize, audio.length);
    if (chunkId === "data") return { start, end };
    // Chunks are word-aligned: an odd size is followed by one pad byte.
    offset = start + chunkSize + (chunkSize % 2);
  }
  return undefined;
};
