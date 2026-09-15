#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy"]
# ///
"""Is this recording whispered, or just quiet?

Whispering removes vocal-fold vibration, so the signal loses its harmonic
structure and its low-frequency energy, and the spectral centroid moves up.
That is a *kind* difference from ordinary speech, not a volume difference — which
is why raising the microphone gain does not make an ASR model understand it.

Three numbers tell the two apart. Run this on a recording whose nature you
already know first, then on the one you are unsure about:

    python3 scripts/whisper-probe.py ~/.local/share/org.gnome.SoundRecorder/*

    normal speech   voiced >30%   below 300 Hz >30%   centroid 200-600 Hz
    whispered       voiced  <15%  below 300 Hz <15%   centroid >1000 Hz

Read it as three agreeing signals, not as a single threshold: a recording with a
breathy speaker, or one captured through a high-pass filter, can move one number
without being whispered.

Needs `ffmpeg` on PATH (it does the decoding and resampling).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

import numpy as np

SAMPLE_RATE = 16000
FRAME = 1024
HOP = 256
# Autocorrelation peaks in this lag range correspond to 60–450 Hz, the span a
# human fundamental frequency falls in. A peak here means the frame is voiced.
PITCH_LAGS = (int(SAMPLE_RATE / 450), int(SAMPLE_RATE / 60))
VOICED_THRESHOLD = 0.35
SILENCE_RMS = 0.003


def decode(path: str) -> np.ndarray:
    """Decode any ffmpeg-readable file to 16 kHz mono floats in [-1, 1]."""
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"],
        capture_output=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"ffmpeg cannot read {path}: {result.stderr.decode(errors='replace').strip()}")
    return np.frombuffer(result.stdout, dtype="<i2").astype(np.float64) / 32768.0


def measure(path: str) -> dict[str, object]:
    samples = decode(path)
    window = np.hanning(FRAME)
    low, high = PITCH_LAGS

    correlations: list[float] = []
    low_band: list[float] = []
    centroids: list[float] = []

    for start in range(0, len(samples) - FRAME, HOP):
        frame = samples[start : start + FRAME]
        if np.sqrt(np.mean(frame**2)) < SILENCE_RMS:  # skip silence, it says nothing
            continue

        centred = frame - frame.mean()

        spectrum = np.abs(np.fft.rfft(centred * window)) ** 2
        frequencies = np.fft.rfftfreq(FRAME, 1 / SAMPLE_RATE)
        total = spectrum.sum() + 1e-12
        low_band.append(spectrum[frequencies < 300].sum() / total)
        centroids.append((spectrum * frequencies).sum() / total)

        autocorrelation = np.correlate(centred, centred, "full")[FRAME - 1 :]
        autocorrelation /= autocorrelation[0] + 1e-12
        correlations.append(float(autocorrelation[low:high].max()))

    if not correlations:
        return {"file": path, "seconds": round(len(samples) / SAMPLE_RATE, 2), "frames": 0}

    correlations_array = np.asarray(correlations)
    return {
        "file": path,
        "seconds": round(len(samples) / SAMPLE_RATE, 2),
        "frames": len(correlations),
        "voicedPercent": round(float((correlations_array > VOICED_THRESHOLD).mean()) * 100, 1),
        "medianAutocorrelation": round(float(np.median(correlations_array)), 3),
        "lowBandPercent": round(float(np.median(low_band)) * 100, 1),
        "centroidHz": round(float(np.median(centroids))),
    }


def verdict(row: dict[str, object]) -> str:
    if not row.get("frames"):
        return "no speech found"
    voiced = float(row["voicedPercent"])  # type: ignore[arg-type]
    low = float(row["lowBandPercent"])  # type: ignore[arg-type]
    if voiced < 15 and low < 15:
        return "whispered"
    if voiced > 30 or low > 30:
        return "normal speech"
    return "ambiguous"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="+", help="audio files to measure")
    parser.add_argument("--json", action="store_true", help="emit one JSON object per file")
    args = parser.parse_args()

    rows = [measure(path) for path in args.files]
    if args.json:
        for row in rows:
            print(json.dumps(row, ensure_ascii=False))
        return

    print(f"{'file':<48}{'sec':>7}{'voiced':>8}{'<300Hz':>8}{'centroid':>10}  verdict")
    for row in rows:
        name = row["file"].split("/")[-1][:46]
        if not row.get("frames"):
            print(f"{name:<48}{row['seconds']:>7}  — no speech frames —")
            continue
        print(
            f"{name:<48}{row['seconds']:>7}{row['voicedPercent']:>7}%"
            f"{row['lowBandPercent']:>7}%{row['centroidHz']:>8}Hz  {verdict(row)}"
        )

    if len(sys.argv) > 1:
        print()
        print("normal speech: voiced >30%, below 300 Hz >30%, centroid 200-600 Hz")
        print("whispered:     voiced  <15%, below 300 Hz <15%, centroid >1000 Hz")


if __name__ == "__main__":
    main()
