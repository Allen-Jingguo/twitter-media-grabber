#!/usr/bin/env bash
#
# Move models fetched by ./download-models.sh into the layout the extension
# loads from for offline transcription:
#
#   models/whisper-base/...   ->   src/models/onnx-community/whisper-base/...
#
# transformers.js resolves a model id ("onnx-community/whisper-base") under
# env.localModelPath (= src/models/), so the files must live at
# src/models/onnx-community/<name>/.
#
# Usage:
#   ./use-local-models.sh            # source dir defaults to ./models
#   ./use-local-models.sh /path/to/models
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-$SCRIPT_DIR/models}"
DEST="$SCRIPT_DIR/src/models/onnx-community"

if [ ! -d "$SRC" ]; then
  echo "!! source dir not found: $SRC" >&2
  echo "   run ./download-models.sh first (or pass the models dir as an argument)." >&2
  exit 1
fi

REQUIRED=(config.json generation_config.json preprocessor_config.json
          tokenizer.json tokenizer_config.json
          onnx/encoder_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx)

mkdir -p "$DEST"
moved=0
for d in "$SRC"/whisper-*; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"

  # Verify the model is complete before installing it.
  ok=1
  for f in "${REQUIRED[@]}"; do
    if [ ! -s "$d/$f" ]; then echo "!! $name missing $f — skipping" >&2; ok=0; break; fi
  done
  [ "$ok" -eq 1 ] || continue

  echo "==> installing $name -> $DEST/$name"
  rm -rf "$DEST/$name"
  mv "$d" "$DEST/$name"
  moved=$((moved + 1))
done

if [ "$moved" -eq 0 ]; then
  echo "!! nothing installed. Expected directories like $SRC/whisper-base" >&2
  exit 1
fi

echo
echo "==> Installed $moved model(s). Layout under src/models/:"
( cd "$SCRIPT_DIR" && find src/models -maxdepth 3 -type d | sort )
echo
echo "Now reload the extension at chrome://extensions and transcribe — the"
echo "selected model loads from disk, no network needed."
