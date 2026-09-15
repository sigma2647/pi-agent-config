#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["qwen-asr", "fastapi", "uvicorn", "python-multipart"]
#
# # CPU-only PyTorch: the default wheel pulls ~2.5 GB of CUDA libraries this
# # machine cannot use (GTX 960, 2 GB). Delete these two blocks on a real GPU.
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
#
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# ///
"""Local OpenAI-compatible /v1/audio/transcriptions server for Qwen3-ASR.

Why a server: Qwen3-ASR is the most accurate Chinese recognizer measured so far
(see `docs/asr-model-selection.md`), but its weights — about 3.4 GB for 1.7B —
are far past what the sherpa-onnx WebAssembly runtime accepts, so it cannot run
inside the extension. Running it here and pointing pi-dictation at the loopback
endpoint keeps the extension unchanged: a local server is just another
`openai-compatible` provider.

Run it (CPU is enough; a GPU is optional). `uv` builds the environment on the
first run, so nothing has to be installed by hand:

    uv run scripts/qwen3-asr-server.py --model Qwen/Qwen3-ASR-1.7B

(The inline metadata below already pins PyTorch to the CPU wheel, so no extra flag
is needed. `--torch-backend=cpu` used to be documented here, but uv 0.12.13 does
not accept it — it fails with "unexpected argument '--torch-backend'".)

First run downloads the weights into the Hugging Face cache (about 3.4 GB for
1.7B, 1.2 GB for 0.6B) and loads them once — allow about a minute before the
first request is served.

Then add one provider to ~/.pi/agent/dictation.json and select it:

    "qwen-local": {
      "type": "openai-compatible",
      "endpoint": "http://127.0.0.1:8123/v1/audio/transcriptions",
      "model": "qwen3-asr",
      "language": "auto"
    }

    /dictation provider qwen-local

Expect roughly real-time decoding on CPU: a 10 s dictation waits about 10 s.
"""

from __future__ import annotations

import argparse
import tempfile
import threading
from pathlib import Path

import torch
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

# Qwen3-ASR wants language names, not the ISO codes the OpenAI API uses.
LANGUAGES = {
    "zh": "Chinese",
    "zh-cn": "Chinese",
    "cmn": "Chinese",
    "en": "English",
    "yue": "Cantonese",
    "ja": "Japanese",
    "ko": "Korean",
}

app = FastAPI(title="qwen3-asr")
model = None
# One recognizer, one request at a time: the model holds the whole CPU anyway.
lock = threading.Lock()
max_new_tokens = 512


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok" if model is not None else "loading"}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_name: str = Form("qwen3-asr", alias="model"),
    language: str | None = Form(None),
) -> dict[str, str]:
    del model_name  # accepted for OpenAI compatibility, only one model is served
    audio = await file.read()
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix) as handle:
        handle.write(audio)
        handle.flush()
        with lock:
            try:
                results = model.transcribe(audio=handle.name, language=LANGUAGES.get((language or "").lower(), None))
            except Exception as error:  # surface the reason instead of a bare 500
                raise HTTPException(status_code=500, detail=f"qwen3-asr failed: {error}") from error
    return {"text": results[0].text}


def main() -> None:
    global model, max_new_tokens
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="Qwen/Qwen3-ASR-1.7B", help="Hugging Face model id or local directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8123)
    parser.add_argument("--max-new-tokens", type=int, default=512, help="raise for recordings longer than about a minute")
    args = parser.parse_args()
    max_new_tokens = args.max_new_tokens

    from qwen_asr import Qwen3ASRModel

    print(f"loading {args.model} on CPU (first run downloads the weights)…", flush=True)
    model = Qwen3ASRModel.from_pretrained(
        args.model,
        dtype=torch.float32,
        device_map="cpu",
        max_new_tokens=max_new_tokens,
    )
    print(f"ready — POST {args.host}:{args.port}/v1/audio/transcriptions", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
