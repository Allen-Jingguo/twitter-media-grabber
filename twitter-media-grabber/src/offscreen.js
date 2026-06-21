/*
 * Offscreen document: decodes recorded audio and transcribes it locally with
 * Whisper (transformers.js + onnxruntime WASM, both vendored in src/vendor/).
 * Model weights are fetched once from huggingface.co at runtime and cached by
 * the browser. Communication: background -> here ('offscreen-transcribe'),
 * here -> background ('transcribe-progress' / 'transcribe-result').
 */
import { pipeline, env, Tensor } from './vendor/transformers.min.js';

// transformers.js logs a benign warning for every model file whose HTTP
// response lacks a Content-Length header (true for files served from the
// extension package): "Unable to determine content-length…". It only affects
// the download-progress estimate, so filter out that single message to keep the
// console readable; every other warning still logs normally.
const origWarn = console.warn.bind(console);
console.warn = (...args) => {
  if (args.length && String(args[0]).includes('Unable to determine content-length from response headers')) return;
  origWarn(...args);
};

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

// transformers.js caches every fetched model file in the Cache API, which only
// supports http(s) request keys. Caching a model file loaded from our own
// extension package (chrome-extension://…/src/models/) therefore throws
// "Request scheme 'chrome-extension' is unsupported". Route caching through a
// wrapper that transparently skips non-http(s) keys: remote Hugging Face
// downloads are still cached across sessions, while bundled local models simply
// aren't re-cached (they load instantly from disk anyway).
const HTTP_KEY = /^https?:/i;
const cacheKeyUrl = (request) => (typeof request === 'string' ? request : (request && request.url) || '');
let realCachePromise = null;
function openRealCache() {
  if (!realCachePromise) {
    realCachePromise = (typeof caches !== 'undefined' ? caches.open('transformers-cache') : Promise.resolve(null))
      .catch(() => null);
  }
  return realCachePromise;
}
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = {
  async match(request) {
    if (!HTTP_KEY.test(cacheKeyUrl(request))) return undefined;
    const c = await openRealCache();
    if (!c) return undefined;
    try { return await c.match(request); } catch (e) { return undefined; }
  },
  async put(request, response) {
    if (!HTTP_KEY.test(cacheKeyUrl(request))) return; // skip chrome-extension:// keys
    const c = await openRealCache();
    if (!c) return;
    try { await c.put(request, response); } catch (e) {}
  }
};
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

// This transformers.js build has no built-in spoken-language detection: running
// a multilingual Whisper model without an explicit `language` makes it silently
// "default to English (en)" (with a warning), which mangles non-English audio.
// So when the user picks auto/mixed we detect the language the way Whisper does
// internally — run a single decoder step from the start-of-transcript token and
// read off the most probable <|lang|> token. Returns an ISO code (e.g. 'zh') or
// null if detection isn't possible.
async function detectLanguage(asr, pcm) {
  const model = asr.model;
  const gc = model && model.generation_config;
  const langToId = gc && gc.lang_to_id;
  const startId = gc && gc.decoder_start_token_id;
  if (!langToId || startId == null || !asr.processor) return null;
  const { input_features } = await asr.processor(pcm);
  const decoder_input_ids = new Tensor('int64', [BigInt(startId)], [1, 1]);
  const out = await model({ input_features, decoder_input_ids });
  const logits = out && out.logits;
  if (!logits || !logits.data) return null;
  const data = logits.data;
  const vocab = logits.dims[logits.dims.length - 1];
  const base = (logits.dims[1] - 1) * vocab; // logits for the last (only) decoder position
  let bestTok = null, bestVal = -Infinity;
  for (const tok in langToId) {
    const v = Number(data[base + langToId[tok]]);
    if (v > bestVal) { bestVal = v; bestTok = tok; }
  }
  const m = bestTok && /<\|([a-z]+)\|>/i.exec(bestTok);
  return m ? m[1].toLowerCase() : null;
}

// Map the popup's language choice to a concrete language for Whisper. 'auto' and
// 'mixed' trigger detection (detecting the dominant language also gives the best
// result for code-switching audio); anything else is used as-is. Returns null
// when detection isn't possible, in which case Whisper falls back to English.
async function resolveLanguage(asr, pcm, lang) {
  if (lang && lang !== 'auto' && lang !== 'mixed') return lang;
  try { return await detectLanguage(asr, pcm); } catch (e) { return null; }
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

    // Resolve auto/mixed to a concrete language so Whisper doesn't fall back to
    // English (this build can't auto-detect during decoding).
    const language = await resolveLanguage(asr, pcm, msg.lang);

    report(tabId, 'transcribing');
    const opts = {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      task: 'transcribe',
      // Stop Whisper looping on the same word ("much, much, much, …"): forbid
      // repeating any 3-token sequence during decoding.
      no_repeat_ngram_size: 3
    };
    if (language) opts.language = language;
    const out = await asr(pcm, opts);

    // Belt-and-braces cleanup of any repetition the decoder still produced, so
    // both the .txt (text) and .srt (chunks) are free of hallucination loops.
    const cleanChunks = (out.chunks || [])
      .map((ch) => ({ timestamp: ch.timestamp, text: T.collapseRepeats(ch.text) }))
      .filter((ch) => ch.text);

    chrome.runtime.sendMessage({
      type: 'transcribe-result',
      tabId: tabId,
      ok: true,
      text: T.collapseRepeats(out.text),
      chunks: cleanChunks,
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
// Overlapping sliding windows: each window covers LIVE_WINDOW_SEC of audio but
// the cursor only advances LIVE_HOP_SEC, so consecutive windows share
// (window-hop) seconds. The overlap means a word split across a boundary is
// fully present in at least one window; dedupeCuesByCursor then discards the
// re-transcribed overlap so the running text isn't duplicated. This is what
// makes long, continuous audio transcribe cleanly in real time.
const LIVE_WINDOW_SEC = 8;
const LIVE_HOP_SEC = 5;
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

// Copy `want` samples from the retained buffer starting at absolute sample
// index `absStart` (>= live.bufStartSample). Returns however many are available.
function liveRead(absStart, want) {
  const out = new Float32Array(want);
  let pos = live.bufStartSample;
  let written = 0;
  for (let b = 0; b < live.buf.length && written < want; b++) {
    const blk = live.buf[b];
    const blkStart = pos;
    pos += blk.length;
    if (pos <= absStart) continue;            // block entirely before window
    const from = Math.max(0, absStart - blkStart);
    const to = Math.min(blk.length, absStart + want - blkStart);
    if (to <= from) continue;
    out.set(blk.subarray(from, to), written);
    written += to - from;
  }
  return written === want ? out : out.subarray(0, written);
}

// Drop buffered blocks that lie entirely before absolute sample index `toAbs`.
function liveTrim(toAbs) {
  while (live.buf.length) {
    const blk = live.buf[0];
    if (live.bufStartSample + blk.length <= toAbs) {
      live.buf.shift();
      live.bufStartSample += blk.length;
      live.bufLen -= blk.length;
    } else break;
  }
}

// Cut the next window out of the buffer (if enough audio is available) and
// queue it for transcription. `force` allows a short (partial) window for the
// first low-latency emit and the final tail flush.
function liveScheduleWindow(force) {
  if (!live) return;
  const avail = live.bufStartSample + live.bufLen - live.nextStart;
  if (avail <= 0) return;
  const want = Math.min(avail, live.winSamples);
  if (!force && want < live.winSamples) return;     // wait for a full window
  if (want < Math.round(live.rate * 0.3)) return;   // <0.3s isn't worth running
  const win = liveRead(live.nextStart, want);
  const startMs = Math.round(live.nextStart / live.rate * 1000);
  const pcm = T.resampleLinear(win, live.rate, TARGET_RATE);
  // Full window -> advance by the hop (keeping the overlap); a partial window
  // (first/tail) consumes everything it read.
  live.nextStart += want >= live.winSamples ? live.hopSamples : want;
  liveTrim(live.nextStart);
  if (pcm.length < TARGET_RATE * 0.3) return;
  live.windows++;
  live.queue = live.queue.then(() => liveTranscribeWindow(pcm, startMs)).catch(() => {});
}

async function liveTranscribeWindow(pcm, startMs) {
  if (!live) return;
  try {
    const asr = await getAsr(live.tabId, live.model);
    // Detect language once (on the first window) and reuse it for the session so
    // every window decodes consistently instead of defaulting to English.
    let language = live.lang;
    if (language === 'auto' || language === 'mixed') {
      if (!live.langDetected) {
        live.langDetected = true;
        live.detectedLang = await resolveLanguage(asr, pcm, live.lang);
      }
      language = live.detectedLang;
    }
    const opts = {
      chunk_length_s: 30,
      return_timestamps: true,
      task: 'transcribe',
      no_repeat_ngram_size: 3
    };
    if (language) opts.language = language;
    const out = await asr(pcm, opts);
    if (!live) return;
    live.results++;
    const durMs = Math.round(pcm.length / TARGET_RATE * 1000);
    // Drop windows that are pure hallucination (silence/noise loops) outright.
    if (T.isDegenerateText(out.text)) { liveReport(); return; }
    let cues = T.sanitizeCues(T.shiftCues(T.whisperChunksToCues(out.chunks || [], durMs), startMs));
    if (!cues.length) {
      const txt = T.collapseRepeats(out.text);
      if (txt) cues = [{ start: startMs, end: startMs + durMs, text: txt }];
    }
    // Discard cues already covered by a previous (overlapping) window.
    const deduped = T.dedupeCuesByCursor(cues, live.cursorMs);
    live.cursorMs = deduped.cursorMs;
    if (deduped.cues.length) {
      live.cues = live.cues.concat(deduped.cues);
      const add = deduped.cues.map((c) => c.text).join(' ');
      live.text = live.text ? live.text + ' ' + add : add;
    }
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

  // Pull mono PCM blocks off the stream with an AudioWorklet — the modern,
  // non-deprecated replacement for ScriptProcessorNode. The worklet posts
  // fixed-size Float32 blocks back here; a zero-gain sink keeps the node in the
  // render graph without adding audible output.
  try {
    await ac.audioWorklet.addModule(chrome.runtime.getURL('src/audio-capture-worklet.js'));
  } catch (e) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { ac.close(); } catch (_) {}
    chrome.runtime.sendMessage({
      type: 'live-progress', error: '无法初始化音频处理器：' + String((e && e.message) || e)
    }).catch(() => {});
    return;
  }
  const node = new AudioWorkletNode(ac, 'tmg-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers'
  });
  const sink = ac.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(ac.destination);

  const rate = ac.sampleRate;
  live = {
    stream, ac, source, node, sink, rate,
    winSamples: Math.round(LIVE_WINDOW_SEC * rate),
    hopSamples: Math.round(LIVE_HOP_SEC * rate),
    firstSamples: Math.round(3 * rate),
    // Retained audio buffer (list of blocks) + absolute-sample bookkeeping.
    buf: [], bufStartSample: 0, bufLen: 0, nextStart: 0, firstDone: false,
    lang: msg.lang, model: msg.model, tabId: msg.tabId,
    detectedLang: null, langDetected: false,
    queue: Promise.resolve(), text: '', cues: [], cursorMs: 0,
    maxLevel: 0, windows: 0, results: 0, lastError: '', stopping: false
  };

  node.port.onmessage = (e) => {
    if (!live || live.stopping) return;
    const copy = e.data;            // Float32Array block (ownership transferred from the worklet)
    const n = copy.length;
    for (let k = 0; k < n; k += 64) { const a = copy[k] < 0 ? -copy[k] : copy[k]; if (a > live.maxLevel) live.maxLevel = a; }
    live.buf.push(copy);
    live.bufLen += n;
    const avail = () => live.bufStartSample + live.bufLen - live.nextStart;
    // First emit fires early (~3s) for low latency; afterwards run full windows.
    if (!live.firstDone && avail() >= live.firstSamples) {
      live.firstDone = true;
      liveScheduleWindow(true);
    }
    while (avail() >= live.winSamples) liveScheduleWindow(false);
  };

  getAsr(live.tabId, live.model).catch(() => {}); // warm up the model
  liveReport();
}

async function liveStop() {
  const cur = live;
  if (!cur || cur.stopping) return;
  cur.stopping = true;
  try { cur.node.port.onmessage = null; } catch (e) {}
  // Flush whatever audio is left after the last full window (a partial tail).
  while (cur.bufStartSample + cur.bufLen - cur.nextStart >= Math.round(cur.rate * 0.3)) {
    liveScheduleWindow(true);
  }
  await cur.queue.catch(() => {});
  try { cur.node.disconnect(); cur.source.disconnect(); cur.sink.disconnect(); } catch (e) {}
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
