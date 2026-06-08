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
