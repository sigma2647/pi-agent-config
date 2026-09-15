#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Character error rate (CER) between one reference transcript and one or more
model outputs.

Used for the tables in `docs/asr-model-selection.md`, where every number is
scored the same way: punctuation and whitespace are dropped, and Arabic digits
are rewritten as Chinese numerals so that "44" and "四十四" are not counted as
three errors.

    python3 scripts/asr-cer.py reference.txt sense-voice.txt fun-asr-nano.txt

Each hypothesis file is one line (or one file) of plain transcript. With --json
the result is machine-readable, which is how the tables were generated.

Two characters on the same line are compared as-is; there is no word
segmentation, because none of the models here agree on one.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Anything a model may or may not emit, that carries no phonetic information.
DROPPED = re.compile(r"[，。？！、,.?!\s：:；;·…—～~“”\"'（）()《》<>]")
DIGITS = str.maketrans("0123456789", "零一二三四五六七八九")


def normalise(text: str) -> str:
    return DROPPED.sub("", text).translate(DIGITS)


def distance(reference: str, hypothesis: str) -> int:
    """Levenshtein distance over characters, one rolling row of memory."""
    previous = list(range(len(hypothesis) + 1))
    for i, ref_char in enumerate(reference, start=1):
        current = [i] + [0] * len(hypothesis)
        for j, hyp_char in enumerate(hypothesis, start=1):
            current[j] = min(
                previous[j] + 1,                                              # deletion
                current[j - 1] + 1,                                           # insertion
                previous[j - 1] + (ref_char != hyp_char),                     # substitution
            )
        previous = current
    return previous[-1]


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("reference", help="file holding the correct transcript")
    parser.add_argument("hypotheses", nargs="+", help="one file per model output")
    parser.add_argument("--json", action="store_true", help="print one JSON object per hypothesis")
    args = parser.parse_args()

    reference = normalise(read(args.reference))
    if not reference:
        raise SystemExit("the reference transcript is empty after normalisation")

    rows = []
    for path in args.hypotheses:
        hypothesis = normalise(read(path))
        errors = distance(reference, hypothesis)
        rows.append(
            {
                "model": Path(path).stem,
                "errors": errors,
                "referenceChars": len(reference),
                "hypothesisChars": len(hypothesis),
                "cer": round(errors / len(reference) * 100, 1),
            }
        )

    if args.json:
        for row in rows:
            print(json.dumps(row, ensure_ascii=False))
        return

    width = max(len(row["model"]) for row in rows)
    print(f"reference: {len(reference)} characters")
    print(f"{'model':<{width}}  {'errors':>7}  {'CER':>6}")
    for row in rows:
        print(f"{row['model']:<{width}}  {row['errors']:>3}/{row['referenceChars']:<3}  {row['cer']:>5}%")


if __name__ == "__main__":
    main()
