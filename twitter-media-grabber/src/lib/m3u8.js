/*
 * Minimal HLS (m3u8) parsing helpers, focused on what we need to extract
 * subtitle (WebVTT) renditions from a master playlist.
 * Pure functions -> unit-testable in node, reused in the content script.
 */
(function (root) {
  'use strict';

  function resolveUrl(base, rel) {
    try { return new URL(rel, base).href; }
    catch (e) { return rel; }
  }

  function isMaster(text) {
    return /#EXT-X-STREAM-INF|#EXT-X-MEDIA/.test(String(text || ''));
  }

  // Parse a single #EXT-X-MEDIA / #EXT-X-STREAM-INF attribute list into an object.
  function parseAttributes(line) {
    var attrs = {};
    var re = /([A-Z0-9\-]+)=(?:"([^"]*)"|([^,]*))/g;
    var m;
    while ((m = re.exec(line))) {
      attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
    }
    return attrs;
  }

  // Return [{ name, language, uri, default }] for every SUBTITLES rendition.
  function parseSubtitleTracks(text, baseUrl) {
    var tracks = [];
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('#EXT-X-MEDIA:') === 0 && /TYPE=SUBTITLES/.test(line)) {
        var attrs = parseAttributes(line);
        if (attrs.URI) {
          tracks.push({
            name: attrs.NAME || attrs.LANGUAGE || 'subtitles',
            language: attrs.LANGUAGE || '',
            "default": attrs.DEFAULT === 'YES',
            uri: resolveUrl(baseUrl, attrs.URI)
          });
        }
      }
    }
    return tracks;
  }

  // Return ordered, absolute segment URLs from a media playlist.
  function parseSegments(text, baseUrl) {
    var segs = [];
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      segs.push(resolveUrl(baseUrl, line));
    }
    return segs;
  }

  var api = {
    resolveUrl: resolveUrl,
    isMaster: isMaster,
    parseAttributes: parseAttributes,
    parseSubtitleTracks: parseSubtitleTracks,
    parseSegments: parseSegments
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TMGM3u8 = api;
})(typeof self !== 'undefined' ? self : this);
