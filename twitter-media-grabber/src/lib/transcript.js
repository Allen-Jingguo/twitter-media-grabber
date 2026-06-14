/*
 * Audio / transcription helpers shared by the offscreen transcriber and the
 * content script. Pure functions only (no DOM, no chrome.*) so they can be
 * unit-tested in node.
 */
(function (root) {
  'use strict';

  // Average N channel buffers (Float32Array-likes) into one mono Float32Array.
  function mixdownChannels(channels) {
    if (!channels || !channels.length) return new Float32Array(0);
    if (channels.length === 1) return Float32Array.from(channels[0]);
    var len = channels[0].length;
    var out = new Float32Array(len);
    var n = channels.length;
    for (var i = 0; i < len; i++) {
      var sum = 0;
      for (var c = 0; c < n; c++) sum += channels[c][i] || 0;
      out[i] = sum / n;
    }
    return out;
  }

  // Linear-interpolation resampler. Good enough as Whisper front-end input.
  function resampleLinear(samples, fromRate, toRate) {
    if (!samples || !samples.length) return new Float32Array(0);
    if (fromRate === toRate) return Float32Array.from(samples);
    var ratio = fromRate / toRate;
    var outLen = Math.max(1, Math.round(samples.length / ratio));
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var i1 = Math.min(i0 + 1, samples.length - 1);
      var frac = pos - i0;
      out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
    }
    return out;
  }

  // Uint8Array <-> base64, chunked to avoid call-stack limits, no Buffer needed.
  function u8ToBase64(u8) {
    var CHUNK = 0x8000;
    var parts = [];
    for (var i = 0; i < u8.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
    }
    var bin = parts.join('');
    if (typeof btoa === 'function') return btoa(bin);
    return Buffer.from(u8).toString('base64'); // node fallback for tests
  }

  function base64ToU8(b64) {
    var bin;
    if (typeof atob === 'function') bin = atob(b64);
    else bin = Buffer.from(b64, 'base64').toString('binary');
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  // Float32 [-1,1] PCM <-> Int16 PCM. Used to halve the size of the audio
  // windows streamed from the page to the offscreen transcriber during live
  // (real-time) transcription.
  function floatToInt16(f32) {
    var out = new Int16Array(f32.length);
    for (var i = 0; i < f32.length; i++) {
      var s = f32[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  function int16ToFloat(i16) {
    var out = new Float32Array(i16.length);
    for (var i = 0; i < i16.length; i++) {
      out[i] = i16[i] < 0 ? i16[i] / 0x8000 : i16[i] / 0x7fff;
    }
    return out;
  }

  // Shift every cue's start/end by deltaMs (used to map a live window's
  // window-relative timestamps onto the absolute media timeline).
  function shiftCues(cues, deltaMs) {
    return (cues || []).map(function (c) {
      return { start: c.start + deltaMs, end: c.end + deltaMs, text: c.text };
    });
  }

  /*
   * Live windows overlap each other, so consecutive windows re-emit cues for
   * the shared audio. Keep only cues that begin at/after the running cursor
   * (the end of the last accepted cue), and advance the cursor. `tolMs` lets a
   * cue that starts slightly before the cursor (jitter in the overlap) through.
   * Returns { cues: kept, cursorMs: newCursor }.
   */
  function dedupeCuesByCursor(cues, cursorMs, tolMs) {
    tolMs = tolMs == null ? 250 : tolMs;
    var kept = [];
    var cur = cursorMs || 0;
    (cues || []).forEach(function (c) {
      if (c.start >= cur - tolMs) {
        kept.push(c);
        if (c.end > cur) cur = c.end;
      }
    });
    return { cues: kept, cursorMs: cur };
  }

  /*
   * Whisper pipelines return { text, chunks: [{ timestamp: [startSec, endSec|null], text }] }.
   * Convert to the cue shape ({start,end,text} in ms) used by TMGVtt.toSrt/toVtt.
   * A null end (common on the final chunk) falls back to the next chunk's
   * start, then totalDurationMs, then start + 2s.
   */
  function whisperChunksToCues(chunks, totalDurationMs) {
    var cues = [];
    chunks = chunks || [];
    for (var i = 0; i < chunks.length; i++) {
      var ch = chunks[i];
      var ts = ch.timestamp || [];
      var text = String(ch.text || '').trim();
      if (!text || ts[0] == null) continue;
      var start = Math.round(ts[0] * 1000);
      var end;
      if (ts[1] != null) {
        end = Math.round(ts[1] * 1000);
      } else {
        var next = chunks[i + 1];
        if (next && next.timestamp && next.timestamp[0] != null) {
          end = Math.round(next.timestamp[0] * 1000);
        } else if (totalDurationMs && totalDurationMs > start) {
          end = Math.round(totalDurationMs);
        } else {
          end = start + 2000;
        }
      }
      if (end <= start) end = start + 500;
      cues.push({ start: start, end: end, text: text });
    }
    return cues;
  }

  var api = {
    mixdownChannels: mixdownChannels,
    resampleLinear: resampleLinear,
    u8ToBase64: u8ToBase64,
    base64ToU8: base64ToU8,
    floatToInt16: floatToInt16,
    int16ToFloat: int16ToFloat,
    shiftCues: shiftCues,
    dedupeCuesByCursor: dedupeCuesByCursor,
    whisperChunksToCues: whisperChunksToCues
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TMGTranscript = api;
})(typeof self !== 'undefined' ? self : this);
