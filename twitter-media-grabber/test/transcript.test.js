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
