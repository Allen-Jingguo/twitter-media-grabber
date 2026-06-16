/*
 * Offscreen document: decodes recorded audio and transcribes it locally with
 * Whisper (transformers.js + onnxruntime WASM, both vendored in src/vendor/).
 * Model weights are fetched once from huggingface.co at runtime and cached by
 * the browser. Communication: background -> here ('offscreen-transcribe'),
 * here -> background ('transcribe-progress' / 'transcribe-result').
 */
import { pipeline, env } from './vendor/transformers.min.js';

const T = self.TMGTranscript;

// Default model. Whisper-base handles mixed Chinese/English noticeably better
// than tiny; the popup can request tiny (faster) or small (most accurate).
const DEFAULT_MODEL = 'onnx-community/whisper-base';
const ALLOWED_MODELS = {
  'onnx-community/whisper-tiny': true,
  'onnx-community/whisper-base': true,
  'onnx-community/whisper-small': true
};
const TARGET_RATE = 16000;

// Prefer models bundled in the extension (src/models/) for fully-offline use;
// fall back to huggingface.co only if a chosen model wasn't downloaded locally.
// Run ./use-local-models.sh after ./download-models.sh to populate src/models/.
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.localModelPath = chrome.runtime.getURL('src/models/');
env.useBrowserCache = true;
// Prefer the vendored ONNX wasm; if this env shape ever changes, ort falls
// back to its default (CDN) wasm path, which our CSP also permits.
const ortWasmEnv = env.backends && env.backends.onnx && env.backends.onnx.wasm;
if (ortWasmEnv) {
  ortWasmEnv.wasmPaths = chrome.runtime.getURL('src/vendor/');
  // Extension pages are not crossOriginIsolated, so SharedArrayBuffer
  // threading is unavailable; force single-threaded WASM.
  ortWasmEnv.numThreads = 1;
}

// One pipeline per model id (a session sticks to one model, but caching per id
// means switching models in the popup doesn't reload an already-loaded one).
const asrPromises = {};

function report(tabId, stage, detail) {
  chrome.runtime.sendMessage({
    type: 'transcribe-progress',
    tabId: tabId,
    stage: stage,
    detail: detail || ''
  }).catch(() => {});
}

function getAsr(tabId, modelId) {
  const id = ALLOWED_MODELS[modelId] ? modelId : DEFAULT_MODEL;
  if (!asrPromises[id]) {
    asrPromises[id] = pipeline('automatic-speech-recognition', id, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p && p.status === 'progress' && p.file) {
          report(tabId, 'downloading-model', p.file + ' ' + Math.round(p.progress || 0) + '%');
        }
      }
    }).catch((e) => {
      asrPromises[id] = null; // allow retry after a failed model download
      throw e;
    });
  }
  return asrPromises[id];
}

async function decodeToPcm16k(bytes) {
  const ctx = new AudioContext();
  try {
    const audioBuf = await ctx.decodeAudioData(bytes.buffer);
    const channels = [];
    for (let c = 0; c < audioBuf.numberOfChannels; c++) {
      channels.push(audioBuf.getChannelData(c));
    }
    const mono = T.mixdownChannels(channels);
    return T.resampleLinear(mono, audioBuf.sampleRate, TARGET_RATE);
  } finally {
    ctx.close().catch(() => {});
  }
}

async function transcribe(msg) {
  const tabId = msg.tabId;
  try {
    report(tabId, 'decoding');
    const pcm = await decodeToPcm16k(T.base64ToU8(msg.b64));
    if (!pcm.length) throw new Error('音频解码后为空');
    const durationMs = Math.round((pcm.length / TARGET_RATE) * 1000);

    report(tabId, 'loading-model');
    const asr = await getAsr(tabId, msg.model);

    report(tabId, 'transcribing');
    const opts = {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      task: 'transcribe'
    };
    // Leave language unset for 'auto'/'mixed' so Whisper detects it per chunk
    // (required for code-switching Chinese/English audio).
    if (msg.lang && msg.lang !== 'auto' && msg.lang !== 'mixed') opts.language = msg.lang;
    const out = await asr(pcm, opts);

    chrome.runtime.sendMessage({
      type: 'transcribe-result',
      tabId: tabId,
      ok: true,
      text: String(out.text || '').trim(),
      chunks: out.chunks || [],
      durationMs: durationMs
    }).catch(() => {});
  } catch (e) {
    chrome.runtime.sendMessage({
      type: 'transcribe-result',
      tabId: tabId,
      ok: false,
      error: String((e && e.message) || e)
    }).catch(() => {});
  }
}

/* ---- live transcription via tab-audio capture ----------------------------
 * captureStream() on a <video> yields silence when the media is cross-origin
 * (Douyin, many CDNs). Capturing the *tab's* audio output instead works
 * regardless, so live transcription runs entirely here: getUserMedia(tab) ->
 * WebAudio -> non-overlapping ~6s windows -> Whisper -> live text to the popup.
 */
const Vtt = self.TMGVtt;
const LIVE_WINDOW_SEC = 6;
let live = null;

function liveReport(extra) {
  if (!live) return;
  chrome.runtime.sendMessage(Object.assign({
    type: 'live-progress',
    text: live.text,
    windows: live.windows,
    results: live.results,
    maxLevel: Math.round(live.maxLevel * 1000) / 1000,
    error: live.lastError
  }, extra || {})).catch(() => {});
}

function liveDrain(want) {
  if (!live || want <= 0 || live.pendingLen < want) return;
  const win = new Float32Array(want);
  let off = 0;
  while (off < want && live.pending.length) {
    const blk = live.pending[0];
    const need = want - off;
    if (blk.length <= need) { win.set(blk, off); off += blk.length; live.pending.shift(); }
    else { win.set(blk.subarray(0, need), off); off += need; live.pending[0] = blk.subarray(need); }
  }
  live.pendingLen -= want;
  const startMs = Math.round(live.emitted / live.rate * 1000);
  live.emitted += want;
  const pcm = T.resampleLinear(win, live.rate, TARGET_RATE);
  if (pcm.length < TARGET_RATE * 0.3) return; // <0.3s
  live.windows++;
  live.queue = live.queue.then(() => liveTranscribeWindow(pcm, startMs)).catch(() => {});
}

async function liveTranscribeWindow(pcm, startMs) {
  if (!live) return;
  try {
    const asr = await getAsr(live.tabId, live.model);
    const opts = { chunk_length_s: 30, return_timestamps: true, task: 'transcribe' };
    if (live.lang && live.lang !== 'auto' && live.lang !== 'mixed') opts.language = live.lang;
    const out = await asr(pcm, opts);
    if (!live) return;
    live.results++;
    const txt = String(out.text || '').trim();
    const durMs = Math.round(pcm.length / TARGET_RATE * 1000);
    let cues = T.shiftCues(T.whisperChunksToCues(out.chunks || [], durMs), startMs);
    if (!cues.length && txt) cues = [{ start: startMs, end: startMs + durMs, text: txt }];
    if (cues.length) live.cues = live.cues.concat(cues);
    if (txt) live.text = live.text ? (live.text + ' ' + txt) : txt;
    liveReport();
  } catch (e) {
    if (live) { live.lastError = String((e && e.message) || e); liveReport(); }
  }
}

async function liveStart(msg) {
  if (live) return;
  let stream, ac;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
      video: false
    });
  } catch (e) {
    chrome.runtime.sendMessage({
      type: 'live-progress', error: '无法捕获标签页音频：' + String((e && e.message) || e)
    }).catch(() => {});
    return;
  }

  ac = new AudioContext();
  const source = ac.createMediaStreamSource(stream);
  // Tab capture re-routes the tab's audio into our stream; play it back so the
  // user still hears the video.
  source.connect(ac.destination);
  const proc = ac.createScriptProcessor(4096, 1, 1);
  const sink = ac.createGain();
  sink.gain.value = 0;
  source.connect(proc);
  proc.connect(sink);
  sink.connect(ac.destination);

  const rate = ac.sampleRate;
  live = {
    stream, ac, source, proc, sink, rate,
    winSamples: Math.round(LIVE_WINDOW_SEC * rate),
    firstSamples: Math.round(3 * rate),
    pending: [], pendingLen: 0, emitted: 0, firstDone: false,
    lang: msg.lang, model: msg.model, tabId: msg.tabId,
    queue: Promise.resolve(), text: '', cues: [],
    maxLevel: 0, windows: 0, results: 0, lastError: '', stopping: false
  };

  proc.onaudioprocess = (e) => {
    if (!live || live.stopping) return;
    const input = e.inputBuffer.getChannelData(0);
    const n = input.length;
    const copy = new Float32Array(n);
    copy.set(input);
    for (let k = 0; k < n; k += 64) { const a = copy[k] < 0 ? -copy[k] : copy[k]; if (a > live.maxLevel) live.maxLevel = a; }
    live.pending.push(copy);
    live.pendingLen += n;
    if (!live.firstDone && live.pendingLen >= live.firstSamples) {
      live.firstDone = true;
      liveDrain(Math.min(live.pendingLen, live.winSamples));
    }
    while (live.pendingLen >= live.winSamples) liveDrain(live.winSamples);
  };

  getAsr(live.tabId, live.model).catch(() => {}); // warm up the model
  liveReport();
}

async function liveStop() {
  const cur = live;
  if (!cur || cur.stopping) return;
  cur.stopping = true;
  try { cur.proc.onaudioprocess = null; } catch (e) {}
  if (cur.pendingLen > 0) liveDrain(cur.pendingLen); // flush the tail window
  await cur.queue.catch(() => {});
  try { cur.proc.disconnect(); cur.source.disconnect(); cur.sink.disconnect(); } catch (e) {}
  try { cur.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  try { cur.ac.close(); } catch (e) {}
  const ordered = cur.cues.slice().sort((a, b) => a.start - b.start);
  chrome.runtime.sendMessage({
    type: 'live-done',
    text: cur.text,
    srt: ordered.length ? Vtt.toSrt(ordered) : '',
    cues: ordered.length,
    windows: cur.windows,
    results: cur.results,
    maxLevel: Math.round(cur.maxLevel * 1000) / 1000,
    error: cur.lastError
  }).catch(() => {});
  live = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'offscreen-transcribe') transcribe(msg);
  else if (msg.type === 'offscreen-live-start') liveStart(msg);
  else if (msg.type === 'offscreen-live-stop') liveStop();
});
