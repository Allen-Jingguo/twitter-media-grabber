# Video Media Grabber

A Manifest V3 browser extension (Chrome / Edge / Brave) that grabs **audio**
and **subtitles (captions)** from videos playing on **any website** (works
great on `twitter.com` / `x.com`), and can **transcribe speech to text
locally** (Whisper via transformers.js — no cloud API, audio never leaves the
browser), saving the transcript to disk as `.txt` + `.srt`.

Two transcription modes:

- **Record → transcribe:** record a clip, then transcribe the whole thing on
  stop.
- **Live (real-time) transcription:** text appears every few seconds *while the
  video plays* — no caption track required, so it effectively **generates
  subtitles for any video that has none**. Stop to save `.txt` + `.srt`.

> For personal use with content you have the right to download. Respect
> copyright and each site's Terms of Service.

## How it works

Most sites (including Twitter/X) play video over **HLS**. The extension's parts:

| File | World | Role |
|------|-------|------|
| `src/inject.js` | MAIN | Patches `fetch`/`XMLHttpRequest` to observe the player's own traffic and discover the master `.m3u8` playlist and rolling `.vtt` caption segments. |
| `src/content.js` | ISOLATED | Receives those discoveries, records `<video>` audio clips (`captureStream()` + `MediaRecorder`), actively fetches subtitle segments from HLS, merges/dedupes, and triggers downloads. |
| `src/popup.{html,js,css}` | — | UI: status, subtitle format picker, audio record/stop, transcribe toggle + language/model, and live-transcription start/stop with a streaming text box. |
| `src/background.js` | service worker | Owns the offscreen document; routes batch transcription; drives the live session (`tabCapture.getMediaStreamId`, keeps live state for the popup to poll, saves `.txt`/`.srt` via `chrome.downloads`). |
| `src/offscreen.html/.js` | offscreen | Runs Whisper (`onnx-community/whisper-{tiny,base,small}`, q8; base default) via vendored transformers.js + ONNX WASM. Also captures **tab audio** (`getUserMedia` tab source) for live transcription and slices it into windows. |

Subtitles are gathered from **three** sources and merged (de-duplicated, sorted):
1. The live `<video>.textTracks` cues.
2. Passively intercepted `.vtt` segments seen while playing.
3. An active walk of the HLS master → subtitle media playlist → all `.vtt`
   segments (so you get the *full* track, not just the played part).

**Live transcription** captures the **tab's audio output** (not the `<video>`
element, which is silent when the media is cross-origin/protected as on Douyin):
the background worker gets a tab media-stream id and the offscreen document opens
it with `getUserMedia`, slices it into non-overlapping ~6 s windows, and runs
each through Whisper. Recognized text is appended directly (so nothing is lost
when a window has no chunk timestamps); chunks only time-stamp the `.srt`.

Pure parsing/audio logic lives in `src/lib/vtt.js`, `src/lib/m3u8.js` and
`src/lib/transcript.js` so it can be unit-tested in node.

## Install (load unpacked)

### One-line terminal install

This clones the extension (if needed), builds the icons, and launches your
Chrome/Edge/Brave/Chromium with it already loaded in an isolated profile:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Allen-Jingguo/Hello-World/claude/brave-euler-EeNza/twitter-media-grabber/install.sh)
```

Or if you already cloned the repo:

```bash
cd twitter-media-grabber && ./install.sh          # launch with the ext loaded
./install.sh --print                              # just print manual steps
```

> A Chromium extension can't be *silently* registered into your normal browser
> profile from the CLI — the browser requires confirmation. The script does the
> next best thing: it opens a throwaway profile with the extension pre-loaded so
> you can use it immediately, leaving your main profile untouched.

### Manual

1. `node tools/make-icons.js` (icons are also committed, so this is optional).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the `twitter-media-grabber/` folder.

## Offline models (optional)

By default the chosen Whisper model is downloaded from huggingface.co on first
use and cached by the browser. To run **fully offline** (and avoid huggingface
being slow/blocked), bundle the weights into the extension:

```bash
./download-models.sh base small        # or: base   /   tiny base small
# (HF blocked? use a mirror: HF_ENDPOINT=https://hf-mirror.com ./download-models.sh base)
./use-local-models.sh                  # moves models/ -> src/models/onnx-community/
```

Then reload the extension. `src/offscreen.js` sets `env.localModelPath` to
`src/models/`, so a model present on disk loads locally (no network); models not
downloaded still fall back to huggingface.co. The weights are git-ignored
(hundreds of MB; some `.onnx` exceed GitHub's 100 MB file limit), so they live
only in your local checkout.

## Usage

1. Open any page with a video (e.g. a tweet on `x.com`) and **play** it.
2. Click the extension icon.
   - **Subtitles:** only works when the video actually ships a caption track
     (turn on **CC**, let it play, pick SRT / VTT / TXT, click **抓取并下载字幕**).
     Many sites (Douyin, etc.) have no caption track — use live transcription.
   - **Live transcription (real-time):** click **开始实时转写**. This captures the
     **tab's audio output** (so it works even where the player protects its
     media, like Douyin, where `video.captureStream()` is silent), transcribes
     it locally window-by-window, and streams text into the popup. Click **停止并
     保存** to download `.txt` + `.srt`.
   - **Audio:** click **开始录制音频** while the video plays, then
     **停止 · 下载 · 转写** when done. The file downloads as `.webm` (Opus).
   - **Speech-to-text:** keep **停止后转写为文字** checked, choose a **语言** and
     **语音模型**. After recording stops, the audio is transcribed locally and a
     `.txt` + `.srt` download automatically. The first run of each model
     downloads it from huggingface.co and caches it; later runs are offline.
   - **Mixed Chinese/English speech:** pick language **中英混合（自动）** (leaves
     Whisper's language unset so it detects per segment — forcing `zh` or `en`
     mangles the other language) and model **base** or **small** (tiny is poor
     at code-switching). Models: tiny ~40 MB, base ~80 MB, small ~250 MB.

## Self-test

```bash
npm test           # static validation + unit tests
npm run test:unit  # vtt + m3u8 parsing unit tests
npm run test:validate
```

`test/validate.js` checks the manifest, that every referenced asset exists, and
that all JS parses. `test/vtt.test.js` / `test/m3u8.test.js` cover the parsing,
timestamp, merge and serialization logic.

> The runtime browser behaviour (`captureStream`, `MediaRecorder`, the popup,
> live network interception) requires loading the unpacked extension in a real
> browser as described above — it can't be exercised by the node test suite.

## Limitations

- **Audio** uses `captureStream()`; if the site's media CDN does not allow
  cross-origin reads for a given clip, `MediaRecorder` may refuse to record it.
  The popup surfaces a clear error in that case.
- **Subtitles** only exist when the video actually ships a caption track.
- Auto-generated/burned-in captions (pixels in the video) cannot be extracted.
- **Transcription** defaults to `whisper-base`; pick `tiny` (faster) or `small`
  (most accurate) in the popup. Accuracy on noisy audio or heavy accents is
  limited. Inference is single-threaded WASM, expect roughly real-time speed on a
  modern laptop. The ONNX runtime WASM backend is vendored in `src/vendor/`
  so the extension stays MV3-compliant (no remote code).

> The vendored ONNX files **must match the onnxruntime-web version bundled in
> `transformers.min.js`** (currently `1.24.3`) — the single-threaded path needs
> `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` and the SIMD path needs
> `ort-wasm-simd-threaded.{mjs,wasm}`. `test/validate.js` parses the bundle and
> asserts every referenced `ort-wasm*` file is present, so a mismatch (which
> shows up at runtime as *"no available backend found / Failed to fetch
> dynamically imported module"*) fails the test suite. To refresh them:
> `npm pack onnxruntime-web@<version>` and copy those four files from `dist/`.
