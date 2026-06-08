# Twitter/X Media Grabber

A Manifest V3 browser extension (Chrome / Edge / Brave) that grabs **subtitles
(captions)** and **audio** from videos playing on `twitter.com` / `x.com`.

> For personal use with content you have the right to download. Respect
> copyright and Twitter/X's Terms of Service.

## How it works

Twitter/X plays video over **HLS**. The extension uses three cooperating parts:

| File | World | Role |
|------|-------|------|
| `src/inject.js` | MAIN | Patches `fetch`/`XMLHttpRequest` to observe the player's own traffic and discover the master `.m3u8` playlist and rolling `.vtt` caption segments. |
| `src/content.js` | ISOLATED | Receives those discoveries, captures `<video>` audio via `captureStream()` + `MediaRecorder`, actively fetches subtitle segments from the HLS playlist, merges/dedupes them, and triggers downloads. |
| `src/popup.{html,js,css}` | — | UI: status, subtitle format picker, audio record/stop. |

Subtitles are gathered from **three** sources and merged (de-duplicated, sorted):
1. The live `<video>.textTracks` cues.
2. Passively intercepted `.vtt` segments seen while playing.
3. An active walk of the HLS master → subtitle media playlist → all `.vtt`
   segments (so you get the *full* track, not just the played part).

Pure parsing logic lives in `src/lib/vtt.js` and `src/lib/m3u8.js` so it can be
unit-tested in node.

## Install (load unpacked)

1. `node tools/make-icons.js` (icons are also committed, so this is optional).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the `twitter-media-grabber/` folder.

## Usage

1. Open a tweet with a video on `twitter.com` / `x.com` and **play** it.
2. Click the extension icon.
   - **Subtitles:** turn on **CC** in the player, let it play a few seconds,
     pick a format (SRT / VTT / TXT) and click **抓取并下载字幕**.
   - **Audio:** click **开始录制音频** while the video plays, then
     **停止并下载** when done. The file downloads as `.webm` (Opus).

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

- **Audio** uses `captureStream()`; if Twitter's media CDN does not allow
  cross-origin reads for a given clip, `MediaRecorder` may refuse to record it.
  The popup surfaces a clear error in that case.
- **Subtitles** only exist when the video actually ships a caption track.
- Auto-generated/burned-in captions (pixels in the video) cannot be extracted.
