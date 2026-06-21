/*
 * WebVTT parsing / merging helpers.
 * Pure functions, no DOM or browser APIs, so they can be unit-tested in node
 * and reused inside the (isolated-world) content script.
 */
(function (root) {
  'use strict';

  // Parse "HH:MM:SS.mmm" / "MM:SS.mmm" (also tolerates a "," ms separator) -> milliseconds.
  function parseTimestamp(ts) {
    if (ts == null) return null;
    var m = String(ts).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
    if (!m) return null;
    var h = m[1] ? parseInt(m[1], 10) : 0;
    var min = parseInt(m[2], 10);
    var s = parseInt(m[3], 10);
    var ms = parseInt((m[4] + '000').slice(0, 3), 10);
    return ((h * 60 + min) * 60 + s) * 1000 + ms;
  }

  // milliseconds -> "HH:MM:SS<sep>mmm"
  function formatTimestamp(ms, sep) {
    sep = sep || '.';
    ms = Math.max(0, Math.round(ms));
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var m = Math.floor(ms / 60000); ms -= m * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + sep + pad(ms, 3);
  }

  function pad(n, w) {
    n = String(n);
    while (n.length < w) n = '0' + n;
    return n;
  }

  function stripTags(s) {
    // Remove WebVTT inline tags (<c>, <i>, <00:00:00.000> karaoke timings, etc.)
    return s.replace(/<[^>]*>/g, '');
  }

  // Does this text look like a WebVTT document (vs. an m3u8 playlist or binary)?
  // Used to tell a subtitle media-playlist apart from a server that returns a
  // single full .vtt directly at the track URI.
  function isVtt(text) {
    if (!text) return false;
    var s = String(text).replace(/^﻿/, '');
    return /^\s*WEBVTT/.test(s) || /-->/.test(s);
  }

  /*
   * HLS chops a caption track into .vtt segments, each restarting its LOCAL
   * cue times near 00:00 and carrying the real program time in a header:
   *   X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000
   * The presentation time of a cue is LOCAL-relative plus (MPEGTS/90000 - LOCAL).
   * Return that per-segment offset in milliseconds (0 when there's no map), so
   * segments can be placed onto one monotonic timeline instead of all collapsing
   * onto 00:00. (MPEGTS ticks at 90 kHz, so /90 converts ticks -> ms.)
   */
  function timestampMapOffset(text) {
    if (!text) return 0;
    var m = String(text).match(/X-TIMESTAMP-MAP\s*=\s*([^\r\n]+)/i);
    if (!m) return 0;
    var spec = m[1];
    var mpegts = spec.match(/MPEGTS\s*:\s*(\d+)/i);
    var local = spec.match(/LOCAL\s*:\s*([0-9:.,]+)/i);
    if (!mpegts) return 0;
    var localMs = local ? parseTimestamp(local[1]) : 0;
    if (localMs == null) localMs = 0;
    return Math.round(parseInt(mpegts[1], 10) / 90 - localMs);
  }

  // Parse a VTT document (or a single media segment) into an array of cues.
  function parseVtt(text) {
    var cues = [];
    if (!text) return cues;
    text = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var blocks = text.split(/\n{2,}/);
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n');
      var idx = -1;
      for (var j = 0; j < lines.length; j++) {
        if (lines[j].indexOf('-->') !== -1) { idx = j; break; }
      }
      if (idx === -1) continue;
      var tm = lines[idx].match(/([0-9:.,]+)\s*-->\s*([0-9:.,]+)/);
      if (!tm) continue;
      var start = parseTimestamp(tm[1]);
      var end = parseTimestamp(tm[2]);
      if (start === null || end === null) continue;
      var cueText = stripTags(lines.slice(idx + 1).join('\n')).trim();
      if (!cueText) continue;
      cues.push({ start: start, end: end, text: cueText });
    }
    return cues;
  }

  // Merge several cue arrays (e.g. one per HLS segment), de-duplicating and sorting.
  function mergeCues(cuesArrays) {
    var seen = Object.create(null);
    var all = [];
    for (var i = 0; i < cuesArrays.length; i++) {
      var cues = cuesArrays[i] || [];
      for (var j = 0; j < cues.length; j++) {
        var c = cues[j];
        var key = c.start + '|' + c.end + '|' + c.text;
        if (seen[key]) continue;
        seen[key] = true;
        all.push({ start: c.start, end: c.end, text: c.text });
      }
    }
    all.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
    return all;
  }

  /*
   * Align a sequence of HLS .vtt *segments* onto one timeline and merge them.
   * Each segment's cues are LOCAL (segment-relative); its X-TIMESTAMP-MAP gives
   * the program-timeline offset. Naively parsing+merging segments makes them all
   * pile up at 00:00 (each restarts near zero), so the downloaded .srt timeline
   * is wrong. Here we shift every segment by (its offset - the smallest offset),
   * which keeps segments monotonic and non-overlapping while dropping the
   * encoder's constant PTS baseline (commonly 900000 ticks = 10s) so the track
   * starts at ~00:00. Segments without a map (a single full .vtt) are unchanged.
   */
  function alignSegmentCues(segmentTexts) {
    var items = [];
    var base = null;
    (segmentTexts || []).forEach(function (txt) {
      var cues = parseVtt(txt);
      if (!cues.length) return;
      var off = timestampMapOffset(txt);
      if (base === null || off < base) base = off;
      items.push({ off: off, cues: cues });
    });
    if (base === null) base = 0;
    var arrays = items.map(function (it) {
      var delta = it.off - base;
      if (!delta) return it.cues;
      return it.cues.map(function (c) {
        return { start: c.start + delta, end: c.end + delta, text: c.text };
      });
    });
    return mergeCues(arrays);
  }

  // Plain running transcript, collapsing immediate repeats (common with rolling captions).
  function toPlainText(cues) {
    var out = [];
    var last = null;
    for (var i = 0; i < cues.length; i++) {
      var t = cues[i].text.replace(/\s*\n\s*/g, ' ').trim();
      if (t && t !== last) { out.push(t); last = t; }
    }
    return out.join('\n');
  }

  function toVtt(cues) {
    var out = ['WEBVTT', ''];
    for (var i = 0; i < cues.length; i++) {
      out.push(formatTimestamp(cues[i].start, '.') + ' --> ' + formatTimestamp(cues[i].end, '.'));
      out.push(cues[i].text);
      out.push('');
    }
    return out.join('\n');
  }

  function toSrt(cues) {
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      out.push(String(i + 1));
      out.push(formatTimestamp(cues[i].start, ',') + ' --> ' + formatTimestamp(cues[i].end, ','));
      out.push(cues[i].text);
      out.push('');
    }
    return out.join('\n');
  }

  var api = {
    parseTimestamp: parseTimestamp,
    formatTimestamp: formatTimestamp,
    stripTags: stripTags,
    isVtt: isVtt,
    timestampMapOffset: timestampMapOffset,
    parseVtt: parseVtt,
    mergeCues: mergeCues,
    alignSegmentCues: alignSegmentCues,
    toPlainText: toPlainText,
    toVtt: toVtt,
    toSrt: toSrt
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TMGVtt = api;
})(typeof self !== 'undefined' ? self : this);
