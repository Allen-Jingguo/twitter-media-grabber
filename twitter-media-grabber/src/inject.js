/*
 * Runs in the page's MAIN world so it can observe the player's own network
 * traffic (fetch + XHR). Twitter/X plays video via HLS; the player requests:
 *   - a master .m3u8 playlist (lists video/audio/subtitle renditions)
 *   - rolling .vtt subtitle segments while captions are enabled
 * We forward those discoveries to the isolated-world content script via
 * window.postMessage. No extension APIs are available here.
 */
(function () {
  'use strict';

  var TAG = 'TMG_PAGE';

  function post(type, payload) {
    try {
      window.postMessage({ source: TAG, type: type, payload: payload }, '*');
    } catch (e) { /* ignore serialization errors */ }
  }

  function looksLikePlaylist(url) {
    return /\.m3u8(\?|$)/i.test(url);
  }
  function looksLikeVtt(url) {
    return /\.vtt(\?|$)/i.test(url) || /\/subtitle|\/captions/i.test(url);
  }

  function handleResponseText(url, text) {
    if (!url || typeof text !== 'string') return;
    if (looksLikePlaylist(url)) {
      // Master playlists reference other renditions; only those help us find subs.
      if (/#EXT-X-STREAM-INF|#EXT-X-MEDIA/.test(text)) {
        post('master-playlist', { url: url, text: text });
      }
    } else if (looksLikeVtt(url) && /-->/.test(text)) {
      post('vtt', { url: url, text: text });
    }
  }

  // --- patch fetch -----------------------------------------------------------
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function () {
      var args = arguments;
      var reqUrl = '';
      try {
        reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      } catch (e) {}
      return origFetch.apply(this, args).then(function (resp) {
        try {
          var url = (resp && resp.url) || reqUrl;
          if (url && (looksLikePlaylist(url) || looksLikeVtt(url))) {
            resp.clone().text().then(function (t) { handleResponseText(url, t); }).catch(function () {});
          }
        } catch (e) {}
        return resp;
      });
    };
  }

  // --- patch XMLHttpRequest ---------------------------------------------------
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__tmgUrl = url;
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var xhr = this;
      var url = xhr.__tmgUrl || '';
      if (url && (looksLikePlaylist(url) || looksLikeVtt(url))) {
        xhr.addEventListener('load', function () {
          try {
            var t = (xhr.responseType === '' || xhr.responseType === 'text') ? xhr.responseText : null;
            if (t != null) handleResponseText(xhr.responseURL || url, t);
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  post('ready', {});
})();
