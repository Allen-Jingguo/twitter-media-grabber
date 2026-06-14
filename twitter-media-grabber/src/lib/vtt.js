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
    parseVtt: parseVtt,
    mergeCues: mergeCues,
    toPlainText: toPlainText,
    toVtt: toVtt,
    toSrt: toSrt
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TMGVtt = api;
})(typeof self !== 'undefined' ? self : this);
