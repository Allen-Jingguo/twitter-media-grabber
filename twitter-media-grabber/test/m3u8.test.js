'use strict';
var H = require('./helpers');
var M3u8 = require('../src/lib/m3u8');

console.log('m3u8 helpers');

var MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="/sub/en.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Japanese",LANGUAGE="ja",DEFAULT=NO,URI="/sub/ja.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=832000,RESOLUTION=640x360,SUBTITLES="subs"',
  '/vid/360.m3u8'
].join('\n');

var MEDIA = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:6',
  '#EXTINF:6.0,',
  'seg0.vtt',
  '#EXTINF:6.0,',
  'seg1.vtt',
  '#EXT-X-ENDLIST'
].join('\n');

H.test('isMaster distinguishes master from media playlists', function (t) {
  t.ok(M3u8.isMaster(MASTER) === true);
  t.ok(M3u8.isMaster(MEDIA) === false);
});

H.test('resolveUrl resolves relative against base', function (t) {
  t.equal(
    M3u8.resolveUrl('https://video.twimg.com/a/b/master.m3u8', '/sub/en.m3u8'),
    'https://video.twimg.com/sub/en.m3u8'
  );
  t.equal(
    M3u8.resolveUrl('https://video.twimg.com/a/b/sub/en.m3u8', 'seg0.vtt'),
    'https://video.twimg.com/a/b/sub/seg0.vtt'
  );
});

H.test('parseAttributes parses quoted and bare values', function (t) {
  var a = M3u8.parseAttributes('#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English",DEFAULT=YES');
  t.equal(a.TYPE, 'SUBTITLES');
  t.equal(a.NAME, 'English');
  t.equal(a.DEFAULT, 'YES');
});

H.test('parseSubtitleTracks returns absolute URIs and default flag', function (t) {
  var tracks = M3u8.parseSubtitleTracks(MASTER, 'https://video.twimg.com/a/b/master.m3u8');
  t.equal(tracks.length, 2);
  t.equal(tracks[0].language, 'en');
  t.equal(tracks[0]['default'], true);
  t.equal(tracks[0].uri, 'https://video.twimg.com/sub/en.m3u8');
  t.equal(tracks[1]['default'], false);
});

H.test('parseSegments returns ordered absolute segment URLs', function (t) {
  var segs = M3u8.parseSegments(MEDIA, 'https://video.twimg.com/a/b/sub/en.m3u8');
  t.equal(segs, [
    'https://video.twimg.com/a/b/sub/seg0.vtt',
    'https://video.twimg.com/a/b/sub/seg1.vtt'
  ]);
});

H.summary();
