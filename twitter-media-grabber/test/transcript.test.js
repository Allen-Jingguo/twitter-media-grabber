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

H.test('collapseRepeats squashes long word-repetition loops', function (t) {
  // The "much, much, much, …" hallucination from the real transcript.
  var much = new Array(120).fill('much,').join(' ');
  t.equal(T.collapseRepeats(much), 'much', 'a wall of "much," collapses to one word');

  // Mixed: a genuine phrase wrapped around a loop keeps the real words.
  t.equal(
    T.collapseRepeats('this, this, this, this, this, times this.'),
    'this times this.',
    'loop collapses but surrounding words survive'
  );
});

H.test('collapseRepeats handles hyphen-joined char loops ("B-B-B-B")', function (t) {
  t.equal(T.collapseRepeats('B-B-B-B-B-B-B-B'), 'B');
  t.equal(T.collapseRepeats('well B-B-B-B done'), 'well B done');
});

H.test('collapseRepeats keeps short, legitimate repeats', function (t) {
  t.equal(T.collapseRepeats('no no no'), 'no no no', '<= threshold (3) untouched');
  t.equal(T.collapseRepeats('Hello world'), 'Hello world');
  t.equal(T.collapseRepeats(''), '');
  t.equal(T.collapseRepeats(null), '');
});

H.test('collapseRepeats squashes CJK loops with no word spaces', function (t) {
  // Chinese has no spaces, so a Whisper loop is one giant token the old
  // whitespace pass could never split — the bug from the Douyin transcript.
  var loop = '以5亿美元的预算来算'.repeat(80);
  t.equal(T.collapseRepeats(loop), '以5亿美元的预算来算', 'long CJK loop -> one copy');

  // A loop embedded in real prose keeps the surrounding speech intact.
  t.equal(
    T.collapseRepeats('本质上是相对独立的服务器' + '一个是H100'.repeat(200)),
    '本质上是相对独立的服务器一个是H100',
    'loop collapses, prose before it survives'
  );

  // Pervasive doubled/tripled phrases (also seen in the transcript) collapse.
  t.equal(T.collapseRepeats('更是因为它的参数也大到惊人'.repeat(3)), '更是因为它的参数也大到惊人');
  t.equal(T.collapseRepeats('另外一家增长强劲'.repeat(2)), '另外一家增长强劲');
});

H.test('collapseRepeats keeps legitimate short CJK reduplication', function (t) {
  // Real Chinese words double single characters; these must not be collapsed.
  t.equal(T.collapseRepeats('看看'), '看看');
  t.equal(T.collapseRepeats('谢谢大家刚刚的提问'), '谢谢大家刚刚的提问');
  // A real sentence with incidental repeated characters stays intact.
  var s = '大模型完成训练之后就进入了我们的电脑和手机';
  t.equal(T.collapseRepeats(s), s);
});

H.test('isDegenerateText flags hallucinated windows, spares real speech', function (t) {
  t.ok(T.isDegenerateText(new Array(50).fill('much').join(' ')), 'one token x50 is degenerate');
  t.ok(T.isDegenerateText('B B B B B B B B'), 'few distinct tokens, many repeats');
  t.ok(!T.isDegenerateText('The Python program runs creates a result and then passes this.'),
    'a normal sentence is not degenerate');
  t.ok(!T.isDegenerateText('much much'), 'too short to judge -> not degenerate');
  // CJK loops have no spaces; counting characters individually still catches them.
  t.ok(T.isDegenerateText('一个是H100'.repeat(20)), 'a Chinese loop is degenerate');
  t.ok(!T.isDegenerateText('大模型完成训练之后就进入了我们的电脑和手机'),
    'a normal Chinese sentence is not degenerate');
});

H.test('sanitizeCues cleans repetition and drops emptied cues', function (t) {
  var cues = T.sanitizeCues([
    { start: 0, end: 1000, text: 'And so, let us see what it looks like.' },
    { start: 1000, end: 6000, text: new Array(80).fill('much,').join(' ') },
    { start: 6000, end: 7000, text: '   ' }
  ]);
  t.equal(cues.length, 2, 'blank cue dropped, others kept');
  t.equal(cues[0].text, 'And so, let us see what it looks like.');
  t.equal(cues[1].text, 'much', 'repetition loop collapsed in place');
});

H.test('live pipeline: overlapping windows dedupe to clean, ordered cues', function (t) {
  // Two overlapping ~8s windows (hop 5s) re-transcribe the shared 3s; one of
  // them also contains a "much" loop. Exercises sanitize + dedupe together.
  var cursor = 0;
  var w1 = T.sanitizeCues(T.shiftCues(T.whisperChunksToCues([
    { timestamp: [0, 3], text: 'The problem now' },
    { timestamp: [3, 6], text: 'is what if we want' }
  ], 8000), 0));
  var d1 = T.dedupeCuesByCursor(w1, cursor); cursor = d1.cursorMs;

  var w2 = T.sanitizeCues(T.shiftCues(T.whisperChunksToCues([
    { timestamp: [0, 1], text: 'is what if we want' },           // overlap, dropped
    { timestamp: [1, 4], text: 'something ' + new Array(40).fill('much,').join(' ') }
  ], 8000), 5000));
  var d2 = T.dedupeCuesByCursor(w2, cursor); cursor = d2.cursorMs;

  var all = d1.cues.concat(d2.cues);
  var text = all.map(function (c) { return c.text; }).join(' ');
  t.equal(text, 'The problem now is what if we want something much',
    'no duplicated overlap, loop collapsed');
  for (var i = 1; i < all.length; i++) t.ok(all[i].start >= all[i - 1].start, 'cues stay ordered');
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
