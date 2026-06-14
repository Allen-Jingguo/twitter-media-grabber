#!/usr/bin/env bash
#
# Download the Whisper model files this extension needs for *offline* local
# transcription, in the exact layout transformers.js expects.
#
# The bundled transformers.js loads q8 weights (dtype 'q8' -> the
# "*_quantized.onnx" files), so we fetch only those plus the small config /
# tokenizer files — not the whole HF repo (which also ships fp16/q4/… variants).
#
# Usage:
#   ./download-models.sh                # downloads whisper-base (recommended)
#   ./download-models.sh base small     # several models
#   ./download-models.sh tiny base small
#   OUT=/path/to/dir ./download-models.sh base   # custom output dir
#
# Output layout (per model), under ./models/ by default:
#   models/whisper-base/
#     config.json generation_config.json preprocessor_config.json
#     tokenizer.json tokenizer_config.json
#     onnx/encoder_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx
set -euo pipefail

MODELS=("$@")
if [ "${#MODELS[@]}" -eq 0 ]; then MODELS=(base); fi

OUT="${OUT:-models}"
HF="${HF_ENDPOINT:-https://huggingface.co}"

ROOT_FILES=(config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json)
ONNX_FILES=(encoder_model_quantized.onnx decoder_model_merged_quantized.onnx)

have() { command -v "$1" >/dev/null 2>&1; }

fetch() {
  # fetch <url> <dest>
  local url="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if have curl; then
    curl -L --fail --retry 3 -o "$dest" "$url"
  elif have wget; then
    wget -q -O "$dest" "$url"
  else
    echo "!! need curl or wget" >&2; exit 1
  fi
}

echo "==> Output dir: $OUT"
echo "==> Endpoint:   $HF"

for short in "${MODELS[@]}"; do
  name="${short#whisper-}"          # accept "base" or "whisper-base"
  repo="onnx-community/whisper-${name}"
  dir="$OUT/whisper-${name}"
  echo
  echo "==> Downloading $repo -> $dir"
  base_url="$HF/$repo/resolve/main"

  for f in "${ROOT_FILES[@]}"; do
    echo "    $f"
    fetch "$base_url/$f" "$dir/$f"
  done
  for f in "${ONNX_FILES[@]}"; do
    echo "    onnx/$f"
    fetch "$base_url/onnx/$f" "$dir/onnx/$f"
  done
done

echo
echo "==> Done. Models saved under: $OUT"
echo "    Sizes:"
du -sh "$OUT"/* 2>/dev/null || true
echo
echo "Next: tell Claude the download is complete and where '$OUT' is, so the"
echo "extension can be switched to load these locally (fully offline)."
