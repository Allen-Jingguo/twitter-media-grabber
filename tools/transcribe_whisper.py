#!/usr/bin/env python3
"""
Transcribe an audio/video file with OpenAI Whisper and write txt/srt/vtt/tsv/json.

Example:
  PYTHONPATH=/tmp/codex-whisper-numpy-2.2 \
    python3 tools/transcribe_whisper.py media/live.douyin.com-audio-2026-06-26_13-37-34.webm

If the global whisper command fails with "Numba needs NumPy 2.2 or less", prepare
the temporary NumPy path once:
  python3 -m pip install --target /tmp/codex-whisper-numpy-2.2 'numpy<2.3,>=2.2'
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe media with Whisper.")
    parser.add_argument("audio", type=Path, help="Input audio/video file.")
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        default=Path("transcripts"),
        help="Directory for output files.",
    )
    parser.add_argument("--model", default="large-v3", help="Whisper model name.")
    parser.add_argument("--language", default="Chinese", help="Spoken language.")
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "cuda", "mps"],
        help="Inference device.",
    )
    parser.add_argument(
        "--decode",
        default="greedy",
        choices=["greedy", "beam"],
        help="Greedy is faster and avoids long-audio beam slowdowns.",
    )
    parser.add_argument("--beam-size", type=int, default=5, help="Beam size for --decode beam.")
    parser.add_argument(
        "--condition-on-previous-text",
        action="store_true",
        help="Carry context across segments. Can improve coherence but may slow or drift.",
    )
    parser.add_argument(
        "--output-format",
        default="all",
        choices=["txt", "vtt", "srt", "tsv", "json", "all"],
        help="Whisper writer output format.",
    )
    return parser.parse_args()


def choose_device(requested: str) -> str:
    if requested != "auto":
        return requested

    import torch

    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model(model_name: str, device: str):
    import whisper

    # Whisper's alignment_heads buffer is sparse. Current PyTorch MPS cannot
    # move that sparse buffer directly, so load on CPU, densify, then move.
    load_device = "cpu" if device == "mps" else device
    model = whisper.load_model(model_name, device=load_device)
    if device == "mps":
        alignment_heads = getattr(model, "alignment_heads", None)
        if alignment_heads is not None and getattr(alignment_heads, "is_sparse", False):
            model.alignment_heads = alignment_heads.to_dense()
        model = model.to("mps")
    return model


def main() -> None:
    args = parse_args()
    audio = args.audio.expanduser().resolve()
    out_dir = args.output_dir.expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not audio.exists():
        raise SystemExit(f"Input file not found: {audio}")

    import whisper
    from whisper.utils import get_writer

    device = choose_device(args.device)
    fp16 = device in {"cuda", "mps"}

    print(f"loading {args.model} on {device}")
    model = load_model(args.model, device)

    decode_options = {}
    if args.decode == "beam":
        decode_options["beam_size"] = args.beam_size

    print(f"transcribing {audio}")
    result = whisper.transcribe(
        model,
        str(audio),
        language=args.language,
        task="transcribe",
        fp16=fp16,
        verbose=False,
        temperature=0,
        condition_on_previous_text=args.condition_on_previous_text,
        **decode_options,
    )

    print(f"writing {args.output_format} to {out_dir}")
    writer = get_writer(args.output_format, str(out_dir))
    writer(
        result,
        str(audio),
        {
            "max_line_width": None,
            "max_line_count": None,
            "highlight_words": False,
            "preserve_segments": False,
        },
    )

    meta = {
        "source": str(audio),
        "model": args.model,
        "device": device,
        "decode": args.decode,
        "language": result.get("language"),
        "segments": len(result.get("segments", [])),
        "text_chars": len(result.get("text", "")),
    }
    (out_dir / f"{audio.stem}.meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("done")


if __name__ == "__main__":
    main()
