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

  // Normalise a token for repeat comparison: lower-case, strip surrounding
  // punctuation/quotes so "much," "much." and "Much" all compare equal.
  function normToken(tok) {
    return String(tok == null ? '' : tok)
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  }

  // Longest repeated unit (in characters / tokens) we hunt for. Whisper loop
  // units are short phrases; a generous cap keeps the scan below O(n*CAP).
  var MAX_CHAR_UNIT = 200;
  var MAX_SEQ_UNIT = 8;

  // True when s[a..a+len) === s[b..b+len) compared char-by-char (no allocation).
  function charsEqual(s, a, b, len) {
    for (var k = 0; k < len; k++) {
      if (s.charCodeAt(a + k) !== s.charCodeAt(b + k)) return false;
    }
    return true;
  }

  /*
   * Collapse adjacent repeats of a substring *inside one whitespace-free token*.
   * CJK scripts (Chinese/Japanese/…) have no word spaces, so a Whisper loop in
   * Chinese is a single token — "以5亿…来算以5亿…来算…" — that the whitespace
   * token pass below can never split. We scan the token and, wherever a unit of
   * length p repeats r times back-to-back, keep a single copy. A long loop
   * (r > threshold) always collapses; a mere double/triple only collapses when
   * the unit is a real multi-char phrase (>= 4 chars), so legitimate Chinese
   * reduplication ("看看", "刚刚", "哈哈") survives untouched.
   */
  function collapseAdjacentRepeats(token, threshold) {
    var n = token.length;
    if (n < 4) return token; // too short to hold a phrase loop
    var out = '';
    var i = 0;
    while (i < n) {
      var maxP = Math.min(MAX_CHAR_UNIT, (n - i) >> 1);
      var bestP = 0, bestR = 0, bestCover = 0;
      for (var p = 1; p <= maxP; p++) {
        // Cheap reject: the unit can only repeat if its first char recurs.
        if (token.charCodeAt(i) !== token.charCodeAt(i + p)) continue;
        var r = 1;
        while (i + (r + 1) * p <= n && charsEqual(token, i, i + r * p, p)) r++;
        var cover = p * r;
        // Prefer the period that tiles the longest run (the true loop period),
        // not a coincidental short prefix that happens to repeat once.
        if (r >= 2 && cover > bestCover) { bestCover = cover; bestP = p; bestR = r; }
      }
      var collapse = bestR >= 2 && (bestR > threshold || bestP >= 4);
      if (collapse) {
        out += token.substr(i, bestP);
        i += bestP * bestR;
      } else {
        out += token.charAt(i);
        i++;
      }
    }
    return out;
  }

  // True when the token runs tokens[a..a+len) and tokens[b..b+len) are equal
  // under normToken (so "this," repeats with "this.").
  function tokenSeqEqual(tokens, a, b, len) {
    for (var k = 0; k < len; k++) {
      if (normToken(tokens[a + k]) !== normToken(tokens[b + k])) return false;
    }
    return true;
  }

  /*
   * Collapse repeated token *sequences* in a token list. A single-token run
   * ("much much much …") collapses only when longer than `threshold` so genuine
   * short repeats ("no no no") survive; a multi-token phrase echoed back-to-back
   * ("A B C A B C" — common when a space-separated clause is re-emitted)
   * collapses from two copies. Returns the cleaned token array.
   */
  function collapseTokenSequenceRepeats(tokens, threshold) {
    var n = tokens.length;
    var out = [];
    var i = 0;
    while (i < n) {
      var maxP = Math.min(MAX_SEQ_UNIT, (n - i) >> 1);
      var bestP = 0, bestR = 0, bestCover = 0;
      for (var p = 1; p <= maxP; p++) {
        if (normToken(tokens[i]) !== normToken(tokens[i + p])) continue;
        var r = 1;
        while (i + (r + 1) * p <= n && tokenSeqEqual(tokens, i, i + r * p, p)) r++;
        var cover = p * r;
        if (r >= 2 && cover > bestCover) { bestCover = cover; bestP = p; bestR = r; }
      }
      // Single tokens need to exceed the threshold; phrase echoes collapse at 2x.
      var collapse = bestR >= 2 && (bestP > 1 ? true : bestR > threshold);
      if (collapse) {
        for (var u = 0; u < bestP; u++) {
          var tok = tokens[i + u];
          // Keep one clean copy, stripping trailing punctuation off the last
          // token of the kept unit (so "this," -> "this").
          if (u === bestP - 1) tok = tok.replace(/[^\p{L}\p{N}]+$/u, '') || tok;
          out.push(tok);
        }
        i += bestP * bestR;
      } else {
        out.push(tokens[i]);
        i++;
      }
    }
    return out;
  }

  /*
   * Whisper loops on near-silent / low-information audio and emits the same
   * phrase many times. In English the repeats are whitespace-separated tokens
   * ("much, much, much, …"); in Chinese they have no spaces at all, so the loop
   * is one giant token ("以5亿…来算以5亿…来算…"). collapseRepeats squashes both:
   * first within-token (CJK), then across the hyphen form ("B-B-B-B"), then over
   * whole token sequences (English words / echoed phrases). Genuine short
   * repeats ("no no no", "看看") are left intact. Pure string -> string so it
   * can be unit-tested and reused for both the batch result and each live window.
   */
  function collapseRepeats(text, opts) {
    if (text == null) return '';
    opts = opts || {};
    var threshold = opts.threshold == null ? 3 : opts.threshold;
    var s = String(text);
    // Hyphen-joined single-token repeats: "B-B-B-B" / "B - B - B" -> "B".
    s = s.replace(/([^\s-]+)(?:\s*-\s*\1){2,}/giu, '$1');
    // Collapse no-space loops living inside each whitespace token (CJK), then
    // collapse repeated token sequences (English words and echoed phrases).
    var tokens = s.split(/\s+/).filter(Boolean).map(function (tok) {
      return collapseAdjacentRepeats(tok, threshold);
    });
    return collapseTokenSequenceRepeats(tokens, threshold).join(' ').trim();
  }

  /*
   * True when `text` is dominated by a handful of distinct tokens repeated many
   * times — the signature of a Whisper hallucination on silence/noise. Used to
   * drop whole windows/cues rather than surface garbage. Short text (< minTokens)
   * is never flagged so ordinary phrases pass through.
   */
  function isDegenerateText(text, opts) {
    opts = opts || {};
    var minTokens = opts.minTokens == null ? 6 : opts.minTokens;
    var maxUniqueRatio = opts.maxUniqueRatio == null ? 0.25 : opts.maxUniqueRatio;
    // Count each CJK character as its own token (those scripts have no word
    // spaces, so a whole repeated phrase would otherwise read as one token and
    // dodge the uniqueness check); Latin/digit runs stay whole words. Padding
    // CJK chars with spaces keeps the \p{L}+ run from swallowing them (CJK
    // ideographs are also \p{L}).
    var toks = String(text == null ? '' : text).toLowerCase()
      .replace(/[㐀-鿿぀-ヿ가-힯]/g, ' $& ')
      .match(/[\p{L}\p{N}]+/gu) || [];
    if (toks.length < minTokens) return false;
    var uniq = Object.create(null);
    for (var i = 0; i < toks.length; i++) uniq[toks[i]] = 1;
    return Object.keys(uniq).length / toks.length <= maxUniqueRatio;
  }

  /*
   * Clean a list of {start,end,text} cues: collapse repetition loops in each
   * cue's text and drop cues that are empty after cleaning. Pure, order-preserving.
   */
  function sanitizeCues(cues, opts) {
    var out = [];
    (cues || []).forEach(function (c) {
      var text = collapseRepeats(c.text, opts);
      if (!text) return;
      out.push({ start: c.start, end: c.end, text: text });
    });
    return out;
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
    collapseRepeats: collapseRepeats,
    isDegenerateText: isDegenerateText,
    sanitizeCues: sanitizeCues,
    whisperChunksToCues: whisperChunksToCues
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TMGTranscript = api;
})(typeof self !== 'undefined' ? self : this);
