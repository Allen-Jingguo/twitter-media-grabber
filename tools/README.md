# Native Whisper host

This optional helper lets the extension route the `large-v3` model through
Chrome native messaging and a local Python/OpenAI Whisper install. Smaller
models still run inside the extension with transformers.js/WASM.

## Setup

Install the Python dependencies in the `python3` environment that should run
the native host:

```bash
python3 -m pip install -U openai-whisper torch
```

Then register the native messaging host:

```bash
bash tools/install_native_host.sh
```

If your unpacked extension ID is different from the default in
`install_native_host.sh`, update `EXT_ID` before running the script. Chrome and
Edge require the native messaging manifest to list the exact extension origin.

After registration, reload the unpacked extension and choose:

```text
large-v3 local GPU
```

The helper writes no transcript files by itself; it returns text and timestamped
segments to the extension, which handles downloads.

## CLI transcription

You can also transcribe a local file outside the browser:

```bash
python3 tools/transcribe_whisper.py media/sample.webm --model large-v3
```

Outputs are written to `transcripts/`, which is intentionally ignored by git.
