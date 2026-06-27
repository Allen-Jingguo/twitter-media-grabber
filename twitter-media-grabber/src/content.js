/*
 * Isolated-world content script. Shares the DOM with the page (so it can read
 * <video> elements and capture their audio) and has access to chrome.* APIs and
 * cross-origin fetch (granted via host_permissions). It bridges the MAIN-world
 * interceptor (window.postMessage) and the popup (chrome.runtime messaging).
 */
(function () {
  'use strict';

  // Idempotent: may be injected via the manifest and again on demand by the
  // popup; a second listener would double-respond, so bail if already loaded.
  if (self.__TMG_CONTENT_LOADED__) return;
  self.__TMG_CONTENT_LOADED__ = true;

  var Vtt = self.TMGVtt;
  var M3u8 = self.TMGM3u8;
  var T = self.TMGTranscript;

  var state = {
    masterPlaylists: {},   // url -> text
    vttSegments: {},       // url -> text (passively captured)
    recorder: null,
    recording: false,
    transcribe: false,     // convert recorded audio to text after stop?
    lang: 'auto',
    model: 'onnx-community/whisper-base',
    transcribeStatus: '',  // '', 'pending', 'working: ...', 'done: ...', 'error: ...'
    transcribeText: ''
  };

  // ---- receive discoveries from the MAIN-world interceptor ------------------
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var data = ev.data;
    if (!data || data.source !== 'TMG_PAGE') return;
    if (data.type === 'master-playlist') {
      state.masterPlaylists[data.payload.url] = data.payload.text;
    } else if (data.type === 'vtt') {
      state.vttSegments[data.payload.url] = data.payload.text;
    }
  });

  // ---- video helpers --------------------------------------------------------
  function listVideos() {
    return Array.prototype.slice.call(document.querySelectorAll('video'));
  }

  function pickVideo() {
    var vids = listVideos();
    // Prefer a video that is actually playing, else the first with a source.
    var playing = vids.filter(function (v) { return !v.paused && !v.ended && v.readyState > 2; });
    if (playing.length) return playing[0];
    var withSrc = vids.filter(function (v) { return v.currentSrc || v.src; });
    return withSrc[0] || vids[0] || null;
  }

  // ---- subtitles: collect from textTracks + passive vtt + active HLS fetch --
  function cuesFromTextTracks() {
    var arrays = [];
    listVideos().forEach(function (v) {
      var tracks = v.textTracks || [];
      for (var i = 0; i < tracks.length; i++) {
        var tt = tracks[i];
        var cueList = tt.cues || [];
        var cues = [];
        for (var j = 0; j < cueList.length; j++) {
          var c = cueList[j];
          if (c.startTime == null) continue;
          var text = Vtt.stripTags(String(c.text || '')).trim();
          if (!text) continue;
          cues.push({ start: Math.round(c.startTime * 1000), end: Math.round(c.endTime * 1000), text: text });
        }
        if (cues.length) arrays.push(cues);
      }
    });
    return arrays;
  }

  // Passively intercepted .vtt are HLS *segments* (each restarts near 00:00 with
  // its real time in X-TIMESTAMP-MAP), so align them onto one timeline before use.
  function cuesFromPassiveVtt() {
    var texts = Object.keys(state.vttSegments).map(function (url) {
      return state.vttSegments[url];
    });
    return Vtt.alignSegmentCues(texts);
  }

  // Walk a discovered master playlist -> subtitle media playlist -> .vtt segments.
  function cuesFromActiveFetch() {
    var masters = Object.keys(state.masterPlaylists);
    if (!masters.length) return Promise.resolve([]);

    var jobs = masters.map(function (masterUrl) {
      var tracks = M3u8.parseSubtitleTracks(state.masterPlaylists[masterUrl], masterUrl);
      if (!tracks.length) return Promise.resolve([]);
      var track = tracks.filter(function (t) { return t["default"]; })[0] || tracks[0];
      return fetchText(track.uri).then(function (mediaText) {
        // The track URI is usually a media playlist, but some servers return a
        // single full .vtt directly — parse that as-is.
        if (Vtt.isVtt(mediaText)) return Vtt.parseVtt(mediaText);
        var segs = M3u8.parseSegments(mediaText, track.uri);
        return Promise.all(segs.map(function (s) {
          return fetchText(s).catch(function () { return ''; });
        })).then(function (segTexts) {
          return Vtt.alignSegmentCues(segTexts);
        });
      }).catch(function () { return []; });
    });

    // Each job resolves to one cue array (already aligned); merge across tracks.
    return Promise.all(jobs).then(function (results) {
      return Vtt.mergeCues(results);
    });
  }

  function fetchText(url) {
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  function grabSubtitles() {
    return cuesFromActiveFetch().then(function (activeCues) {
      // cuesFromTextTracks() is an array-of-arrays (one per track); the passive
      // and active sources are each a single aligned cue array.
      var all = cuesFromTextTracks().concat([cuesFromPassiveVtt(), activeCues]);
      var merged = Vtt.mergeCues(all);
      return {
        count: merged.length,
        srt: Vtt.toSrt(merged),
        vtt: Vtt.toVtt(merged),
        txt: Vtt.toPlainText(merged)
      };
    });
  }

  // ---- audio capture --------------------------------------------------------
  function pickMime() {
    var candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];
    if (typeof MediaRecorder === 'undefined') return '';
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function startAudio(opts) {
    opts = opts || {};
    if (state.recording) return { ok: false, error: '已经在录制中。' };
    var video = pickVideo();
    if (!video) return { ok: false, error: '页面上没有找到视频。请先播放一个视频。' };

    var capture = video.captureStream || video.mozCaptureStream;
    if (!capture) return { ok: false, error: '当前浏览器不支持 captureStream。' };

    var stream;
    try {
      stream = capture.call(video);
    } catch (e) {
      return { ok: false, error: '无法捕获媒体流：' + e.message };
    }
    var audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      return { ok: false, error: '该视频没有音轨，或音轨尚未就绪（请确保视频正在播放且未静音）。' };
    }

    var mime = pickMime();
    var audioStream = new MediaStream(audioTracks);
    var rec;
    try {
      rec = mime ? new MediaRecorder(audioStream, { mimeType: mime }) : new MediaRecorder(audioStream);
    } catch (e) {
      return { ok: false, error: '无法创建录制器（音频可能受跨域保护）：' + e.message };
    }

    var chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      var type = rec.mimeType || mime || 'audio/webm';
      var blob = new Blob(chunks, { type: type });
      var ext = /ogg/.test(type) ? 'ogg' : /mp4/.test(type) ? 'm4a' : 'webm';
      downloadBlob(blob, siteName() + '-audio-' + tsName() + '.' + ext);
      state.recording = false;
      state.recorder = null;
      if (state.transcribe) sendForTranscription(blob, type);
    };
    try {
      // Flush a chunk every few seconds (timeslice) instead of buffering the
      // whole recording into a single Blob at stop — this keeps memory bounded
      // for long (30+ min) captures.
      rec.start(5000);
    } catch (e) {
      return { ok: false, error: '录制启动失败（音频可能受跨域保护）：' + e.message };
    }
    state.recorder = rec;
    state.recording = true;
    state.transcribe = !!opts.transcribe;
    state.lang = opts.lang || 'auto';
    if (opts.model) state.model = opts.model;
    state.transcribeStatus = state.transcribe ? 'pending' : '';
    return { ok: true, mime: rec.mimeType || mime };
  }

  // ---- speech-to-text (runs in the extension's offscreen document) ----------
  function sendForTranscription(blob, mime) {
    state.transcribeStatus = 'working: 准备音频…';
    blob.arrayBuffer().then(function (buf) {
      return chrome.runtime.sendMessage({
        type: 'transcribe-audio',
        b64: T.u8ToBase64(new Uint8Array(buf)),
        mime: mime,
        lang: state.lang,
        model: state.model
      });
    }).catch(function (e) {
      state.transcribeStatus = 'error: ' + String((e && e.message) || e);
    });
  }

  function onTranscribeResult(msg) {
    if (!msg.ok) {
      state.transcribeStatus = 'error: ' + (msg.error || '未知错误');
      return;
    }
    if (!msg.text && !(msg.chunks && msg.chunks.length)) {
      state.transcribeStatus = 'error: 未识别出任何文字';
      return;
    }
    var name = siteName() + '-transcript-' + tsName();
    downloadText(msg.text || '', name + '.txt', 'text/plain');
    var cues = T.whisperChunksToCues(msg.chunks, msg.durationMs);
    if (cues.length) downloadText(Vtt.toSrt(cues), name + '.srt', 'application/x-subrip');
    state.transcribeText = msg.text || '';
    state.transcribeStatus = 'done: ' + state.transcribeText.length + ' 字符，' + cues.length + ' 条时间轴';
  }

  function stopAudio() {
    if (!state.recording || !state.recorder) return { ok: false, error: '当前没有录制任务。' };
    try { state.recorder.stop(); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true };
  }

  // ---- downloads ------------------------------------------------------------
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 2000);
  }

  function downloadText(text, filename, mime) {
    downloadBlob(new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' }), filename);
  }

  function tsName() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  }

  // Filename prefix derived from the current site, e.g. "x.com" -> "x.com".
  function siteName() {
    var host = (location.hostname || 'video').replace(/^www\./, '');
    return host.replace(/[^a-zA-Z0-9.-]/g, '') || 'video';
  }

  // ---- popup messaging ------------------------------------------------------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    if (msg.type === 'status') {
      sendResponse({
        videos: listVideos().length,
        masters: Object.keys(state.masterPlaylists).length,
        vttSegments: Object.keys(state.vttSegments).length,
        recording: state.recording,
        transcribeStatus: state.transcribeStatus,
        transcribeText: state.transcribeText
      });
      return true;
    }

    if (msg.type === 'transcribe-progress') {
      var stages = {
        'decoding': '解码音频…',
        'loading-model': '加载语音模型…',
        'downloading-model': '下载模型 ' + (msg.detail || ''),
        // Long clips are transcribed in segments, so show the running percentage
        // instead of a static label that looks frozen for minutes.
        'transcribing': '识别中…' + (msg.detail ? ' ' + msg.detail : '')
      };
      state.transcribeStatus = 'working: ' + (stages[msg.stage] || msg.stage);
      return;
    }

    if (msg.type === 'transcribe-result') {
      onTranscribeResult(msg);
      return;
    }

    if (msg.type === 'grab-subtitles') {
      grabSubtitles().then(function (res) {
        if (!res.count) {
          sendResponse({ ok: false, error: '未捕获到字幕轨。该视频可能没有字幕——可改用下方“实时转写”直接从声音生成字幕。' });
          return;
        }
        var fmt = msg.format || 'srt';
        var name = siteName() + '-subtitles-' + tsName() + '.' + fmt;
        var mime = fmt === 'vtt' ? 'text/vtt' : fmt === 'txt' ? 'text/plain' : 'application/x-subrip';
        downloadText(res[fmt] || res.srt, name, mime);
        sendResponse({ ok: true, count: res.count });
      }).catch(function (e) {
        sendResponse({ ok: false, error: '抓取字幕出错：' + e.message });
      });
      return true; // async
    }

    if (msg.type === 'start-audio') {
      sendResponse(startAudio({ transcribe: msg.transcribe, lang: msg.lang, model: msg.model }));
      return true;
    }

    if (msg.type === 'stop-audio') {
      sendResponse(stopAudio());
      return true;
    }
  });
})();
