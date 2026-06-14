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

// Live transcription: each window is a short raw-PCM slice. Serialize them on
// a single promise chain so the (non-reentrant) Whisper pipeline runs them one
// at a time and results come back in order.
let chunkQueue = Promise.resolve();

async function transcribeChunk(msg) {
  const tabId = msg.tabId;
  try {
    const i16 = new Int16Array(T.base64ToU8(msg.b64).buffer);
    let pcm = T.int16ToFloat(i16);
    if (msg.sampleRate && msg.sampleRate !== TARGET_RATE) {
      pcm = T.resampleLinear(pcm, msg.sampleRate, TARGET_RATE);
    }
    if (!pcm.length) throw new Error('空音频窗口');

    const asr = await getAsr(tabId, msg.model);
    const opts = { chunk_length_s: 30, return_timestamps: true, task: 'transcribe' };
    if (msg.lang && msg.lang !== 'auto' && msg.lang !== 'mixed') opts.language = msg.lang;
    const out = await asr(pcm, opts);

    chrome.runtime.sendMessage({
      type: 'transcribe-chunk-result',
      tabId: tabId,
      ok: true,
      seq: msg.seq,
      windowStartMs: msg.windowStartMs,
      windowDurationMs: msg.windowDurationMs,
      text: String(out.text || '').trim(),
      chunks: out.chunks || []
    }).catch(() => {});
  } catch (e) {
    chrome.runtime.sendMessage({
      type: 'transcribe-chunk-result',
      tabId: tabId,
      ok: false,
      seq: msg.seq,
      error: String((e && e.message) || e)
    }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'offscreen-transcribe') {
    transcribe(msg);
  } else if (msg && msg.type === 'offscreen-transcribe-chunk') {
    chunkQueue = chunkQueue.then(() => transcribeChunk(msg)).catch(() => {});
  }
});
