'use strict';
var H = require('./helpers');
var Vtt = require('../src/lib/vtt');

console.log('VTT helpers');

H.test('parseTimestamp handles HH:MM:SS.mmm and MM:SS.mmm', function (t) {
  t.equal(Vtt.parseTimestamp('00:00:01.500'), 1500);
  t.equal(Vtt.parseTimestamp('01:02:03.004'), ((1 * 60 + 2) * 60 + 3) * 1000 + 4);
  t.equal(Vtt.parseTimestamp('00:05.250'), 5250);
  t.equal(Vtt.parseTimestamp('00:00:02,250'), 2250, 'tolerates comma');
  t.equal(Vtt.parseTimestamp('garbage'), null);
});

H.test('formatTimestamp round-trips with parseTimestamp', function (t) {
  t.equal(Vtt.formatTimestamp(1500, '.'), '00:00:01.500');
  t.equal(Vtt.formatTimestamp(3723004, '.'), '01:02:03.004');
  t.equal(Vtt.formatTimestamp(3723004, ','), '01:02:03,004');
  t.equal(Vtt.parseTimestamp(Vtt.formatTimestamp(987654, '.')), 987654);
});

H.test('parseVtt extracts cues and strips tags', function (t) {
  var doc = [
    'WEBVTT',
    '',
    '1',
    '00:00:00.000 --> 00:00:02.000',
    '<c.yellow>Hello</c> <i>world</i>',
    '',
    '00:00:02.000 --> 00:00:04.000',
    'Second <00:00:03.000>line'
  ].join('\n');
  var cues = Vtt.parseVtt(doc);
  t.equal(cues.length, 2);
  t.equal(cues[0], { start: 0, end: 2000, text: 'Hello world' });
  t.equal(cues[1].text, 'Second line');
});

H.test('parseVtt ignores blocks without timing and empty text', function (t) {
  var doc = 'WEBVTT\n\nNOTE just a comment\n\n00:00:01.000 --> 00:00:02.000\n   ';
  t.equal(Vtt.parseVtt(doc), []);
});

H.test('mergeCues de-duplicates overlapping segments and sorts', function (t) {
  var a = [{ start: 2000, end: 4000, text: 'B' }, { start: 0, end: 2000, text: 'A' }];
  var b = [{ start: 2000, end: 4000, text: 'B' }, { start: 4000, end: 6000, text: 'C' }];
  var merged = Vtt.mergeCues([a, b]);
  t.equal(merged.map(function (c) { return c.text; }), ['A', 'B', 'C']);
});

H.test('isVtt recognizes WebVTT and rejects m3u8 playlists', function (t) {
  t.ok(Vtt.isVtt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi') === true);
  t.ok(Vtt.isVtt('﻿WEBVTT') === true, 'tolerates BOM');
  t.ok(Vtt.isVtt('00:00:01.000 --> 00:00:02.000\nno header') === true, 'a bare cue still counts');
  t.ok(Vtt.isVtt('#EXTM3U\n#EXTINF:6.0,\nseg0.vtt') === false, 'media playlist is not VTT');
  t.ok(Vtt.isVtt('') === false);
});

H.test('timestampMapOffset reads MPEGTS/LOCAL in either order', function (t) {
  t.equal(Vtt.timestampMapOffset('WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n'),
    10000, '900000 ticks / 90 = 10000ms');
  t.equal(Vtt.timestampMapOffset('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:1440000'),
    16000, 'order-independent');
  t.equal(Vtt.timestampMapOffset('WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:990000,LOCAL:00:00:01.000'),
    10000, 'subtracts LOCAL (11000 - 1000)');
  t.equal(Vtt.timestampMapOffset('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi'), 0, 'no map -> 0');
});

H.test('alignSegmentCues places HLS segments on one monotonic timeline', function (t) {
  // Two segments: each restarts LOCAL near 00:00 but carries an increasing
  // MPEGTS. Naive parse+merge would sort "World" before "Hello" at ~00:00.
  var seg1 = [
    'WEBVTT',
    'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000',
    '',
    '00:00:01.000 --> 00:00:03.000',
    'Hello'
  ].join('\n');
  var seg2 = [
    'WEBVTT',
    'X-TIMESTAMP-MAP=MPEGTS:1440000,LOCAL:00:00:00.000',
    '',
    '00:00:00.500 --> 00:00:02.000',
    'World'
  ].join('\n');
  var cues = Vtt.alignSegmentCues([seg1, seg2]);
  t.equal(cues.length, 2);
  // baseline (10000ms) removed -> seg1 keeps its local times, seg2 shifts +6s.
  t.equal(cues[0], { start: 1000, end: 3000, text: 'Hello' });
  t.equal(cues[1], { start: 6500, end: 8000, text: 'World' }, 'second segment after the first');
  t.ok(cues[1].start > cues[0].end, 'no overlap / correct order');
});

H.test('alignSegmentCues de-duplicates overlapping rolling segments', function (t) {
  // Rolling captions: consecutive segments repeat the shared cue.
  var a = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n' +
          '00:00:00.000 --> 00:00:02.000\nA\n\n00:00:02.000 --> 00:00:04.000\nB';
  var b = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n' +
          '00:00:02.000 --> 00:00:04.000\nB\n\n00:00:04.000 --> 00:00:06.000\nC';
  var cues = Vtt.alignSegmentCues([a, b]);
  t.equal(cues.map(function (c) { return c.text; }), ['A', 'B', 'C']);
});

H.test('alignSegmentCues leaves a single map-less .vtt unchanged', function (t) {
  var doc = 'WEBVTT\n\n00:00:05.000 --> 00:00:07.000\nlate caption';
  t.equal(Vtt.alignSegmentCues([doc]), [{ start: 5000, end: 7000, text: 'late caption' }]);
  t.equal(Vtt.alignSegmentCues([]), [], 'empty input -> empty');
});

H.test('toSrt / toVtt / toPlainText render expected output', function (t) {
  var cues = [
    { start: 0, end: 2000, text: 'Hello' },
    { start: 2000, end: 4000, text: 'Hello' },
    { start: 4000, end: 6000, text: 'World' }
  ];
  t.equal(Vtt.toPlainText(cues), 'Hello\nWorld', 'collapses immediate repeat');
  t.ok(Vtt.toVtt(cues).indexOf('WEBVTT') === 0);
  t.ok(Vtt.toVtt(cues).indexOf('00:00:00.000 --> 00:00:02.000') !== -1);
  var srt = Vtt.toSrt(cues);
  t.ok(srt.indexOf('1\n00:00:00,000 --> 00:00:02,000\nHello') === 0, 'srt uses comma + index');
});

H.summary();
