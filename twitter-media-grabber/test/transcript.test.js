'use strict';
var H = require('./helpers');
var T = require('../src/lib/transcript');
var Vtt = require('../src/lib/vtt');

console.log('transcript helpers');

H.test('mixdownChannels averages channels, passes mono through', function (t) {
  var mono = T.mixdownChannels([new Float32Array([0.5, -0.5])]);
  t.equal(Array.from(mono), [0.5, -0.5]);
  var mixed = T.mixdownChannels([
    new Float32Array([1, 0, -1]),
    new Float32Array([0, 1, -1])
  ]);
  t.equal(Array.from(mixed), [0.5, 0.5, -1]);
  t.equal(T.mixdownChannels([]).length, 0);
});

H.test('resampleLinear: identity at same rate, correct length down/up', function (t) {
  var s = new Float32Array([0, 1, 2, 3]);
  t.equal(Array.from(T.resampleLinear(s, 16000, 16000)), [0, 1, 2, 3]);

  var down = T.resampleLinear(new Float32Array(48000), 48000, 16000);
  t.equal(down.length, 16000, '1s at 48k -> 1s at 16k');

  var up = T.resampleLinear(new Float32Array(8000), 8000, 16000);
  t.equal(up.length, 16000, '1s at 8k -> 1s at 16k');
});

H.test('resampleLinear interpolates linearly', function (t) {
  // Ramp 0..1: halving rate keeps a ramp; values must lie on the line.
  var ramp = new Float32Array(9);
  for (var i = 0; i < 9; i++) ramp[i] = i / 8;
  var out = T.resampleLinear(ramp, 16000, 8000);
  for (var j = 0; j < out.length; j++) {
    var expected = (j * 2) / 8;
    t.ok(Math.abs(out[j] - expected) < 1e-6, 'sample ' + j + ' on the ramp');
  }
});

H.test('base64 round-trip, including chunk boundary sizes', function (t) {
  [0, 1, 3, 0x8000 - 1, 0x8000, 0x8000 + 1, 100000].forEach(function (n) {
    var u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = (i * 31 + 7) & 0xff;
    var back = T.base64ToU8(T.u8ToBase64(u8));
    t.equal(back.length, n, 'length ' + n);
    for (var j = 0; j < n; j += Math.max(1, n >> 4)) {
      t.ok(back[j] === u8[j], 'byte ' + j + ' of ' + n);
    }
  });
});

H.test('base64 output matches node Buffer encoding', function (t) {
  var u8 = new Uint8Array([72, 101, 108, 108, 111, 0, 255, 128]);
  t.equal(T.u8ToBase64(u8), Buffer.from(u8).toString('base64'));
});

H.test('whisperChunksToCues converts seconds to ms and trims', function (t) {
  var cues = T.whisperChunksToCues([
    { timestamp: [0, 2.5], text: ' Hello world ' },
    { timestamp: [2.5, 4], text: 'Second' }
  ], 4000);
  t.equal(cues, [
    { start: 0, end: 2500, text: 'Hello world' },
    { start: 2500, end: 4000, text: 'Second' }
  ]);
});

H.test('whisperChunksToCues handles null end timestamps', function (t) {
  var cues = T.whisperChunksToCues([
    { timestamp: [0, null], text: 'A' },
    { timestamp: [3, null], text: 'B' }
  ], 10000);
  t.equal(cues[0].end, 3000, 'null end -> next chunk start');
  t.equal(cues[1].end, 10000, 'last null end -> total duration');

  var noDur = T.whisperChunksToCues([{ timestamp: [1, null], text: 'X' }], 0);
  t.equal(noDur[0].end, 3000, 'no duration -> start + 2s');
});

H.test('whisperChunksToCues skips empty/invalid chunks', function (t) {
  var cues = T.whisperChunksToCues([
    { timestamp: [0, 1], text: '   ' },
    { timestamp: [null, 2], text: 'no start' },
    { text: 'no timestamp' },
    { timestamp: [2, 2], text: 'zero-length' }
  ], 5000);
  t.equal(cues.length, 1);
  t.ok(cues[0].end > cues[0].start, 'zero-length cue gets a minimum duration');
});

H.test('floatToInt16 / int16ToFloat round-trip within quantization error', function (t) {
  var f = new Float32Array([0, 1, -1, 0.5, -0.5, 0.25, 2, -2]);
  var i16 = T.floatToInt16(f);
  t.equal(i16[1], 0x7fff, '+1.0 -> max');
  t.equal(i16[2], -0x8000, '-1.0 -> min');
  t.equal(i16[6], 0x7fff, '+2.0 clamps to max');
  t.equal(i16[7], -0x8000, '-2.0 clamps to min');
  var back = T.int16ToFloat(i16);
  [0, 0.5, -0.5, 0.25].forEach(function (v, k) {
    var idx = [0, 3, 4, 5][k];
    t.ok(Math.abs(back[idx] - v) < 1e-3, 'sample ' + v + ' recovered');
  });
});

H.test('int16 PCM survives base64 transport (live window path)', function (t) {
  var f = new Float32Array(1000);
  for (var i = 0; i < f.length; i++) f[i] = Math.sin(i / 7) * 0.8;
  var i16 = T.floatToInt16(f);
  var b64 = T.u8ToBase64(new Uint8Array(i16.buffer));
  var got = new Int16Array(T.base64ToU8(b64).buffer);
  t.equal(got.length, i16.length, 'sample count preserved');
  for (var j = 0; j < i16.length; j += 97) t.ok(got[j] === i16[j], 'sample ' + j);
});

H.test('shiftCues offsets start/end onto the absolute timeline', function (t) {
  var cues = T.shiftCues([{ start: 0, end: 500, text: 'a' }, { start: 500, end: 1000, text: 'b' }], 8000);
  t.equal(cues, [
    { start: 8000, end: 8500, text: 'a' },
    { start: 8500, end: 9000, text: 'b' }
  ]);
});

H.test('dedupeCuesByCursor drops overlap and advances the cursor', function (t) {
  // First window produced cues up to 5000ms.
  var first = T.dedupeCuesByCursor([
    { start: 0, end: 2000, text: 'one' },
    { start: 2000, end: 5000, text: 'two' }
  ], 0);
  t.equal(first.cursorMs, 5000);
  t.equal(first.cues.length, 2);

  // Next (overlapping) window re-emits 'two' plus new 'three'; only 'three' kept.
  var second = T.dedupeCuesByCursor([
    { start: 2000, end: 5000, text: 'two' },
    { start: 5000, end: 7000, text: 'three' }
  ], first.cursorMs);
  t.equal(second.cues.length, 1);
  t.equal(second.cues[0].text, 'three');
  t.equal(second.cursorMs, 7000);
});

H.test('dedupeCuesByCursor tolerates small jitter before the cursor', function (t) {
  var r = T.dedupeCuesByCursor([{ start: 4900, end: 6000, text: 'x' }], 5000);
  t.equal(r.cues.length, 1, 'within 250ms tolerance is kept');
  var r2 = T.dedupeCuesByCursor([{ start: 4000, end: 6000, text: 'y' }], 5000);
  t.equal(r2.cues.length, 0, 'well before cursor is dropped');
});

H.test('cues from whisper render to valid SRT via TMGVtt', function (t) {
  var cues = T.whisperChunksToCues([
    { timestamp: [0, 1.5], text: '你好，世界' },
    { timestamp: [1.5, 3], text: 'Hello world' }
  ], 3000);
  var srt = Vtt.toSrt(cues);
  t.ok(srt.indexOf('1\n00:00:00,000 --> 00:00:01,500\n你好，世界') === 0);
  t.ok(srt.indexOf('2\n00:00:01,500 --> 00:00:03,000\nHello world') !== -1);
});

H.summary();
