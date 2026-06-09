/*
 * Isolated-world content script. Shares the DOM with the page (so it can read
 * <video> elements and capture their audio) and has access to chrome.* APIs and
 * cross-origin fetch (granted via host_permissions). It bridges the MAIN-world
 * interceptor (window.postMessage) and the popup (chrome.runtime messaging).
 */
(function () {
  'use strict';

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
    transcribeStatus: ''   // '', 'pending', 'working: ...', 'done: ...', 'error: ...'
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

  function cuesFromPassiveVtt() {
    return Object.keys(state.vttSegments).map(function (url) {
      return Vtt.parseVtt(state.vttSegments[url]);
    });
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
        var segs = M3u8.parseSegments(mediaText, track.uri);
        return Promise.all(segs.map(function (s) {
          return fetchText(s).then(function (t) { return Vtt.parseVtt(t); })
            .catch(function () { return []; });
        }));
      }).catch(function () { return []; });
    });

    return Promise.all(jobs).then(function (results) {
      // results is an array of (array of cue-arrays); flatten one level.
      var flat = [];
      results.forEach(function (r) { flat = flat.concat(r); });
      return flat;
    });
  }

  function fetchText(url) {
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  function grabSubtitles() {
    return cuesFromActiveFetch().then(function (activeArrays) {
      var all = [].concat(cuesFromTextTracks(), cuesFromPassiveVtt(), activeArrays);
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
      downloadBlob(blob, 'twitter-audio-' + tsName() + '.' + ext);
      state.recording = false;
      state.recorder = null;
      if (state.transcribe) sendForTranscription(blob, type);
    };
    try {
      rec.start();
    } catch (e) {
      return { ok: false, error: '录制启动失败（音频可能受跨域保护）：' + e.message };
    }
    state.recorder = rec;
    state.recording = true;
    state.transcribe = !!opts.transcribe;
    state.lang = opts.lang || 'auto';
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
        lang: state.lang
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
    var name = 'twitter-transcript-' + tsName();
    downloadText(msg.text || '', name + '.txt', 'text/plain');
    var cues = T.whisperChunksToCues(msg.chunks, msg.durationMs);
    if (cues.length) downloadText(Vtt.toSrt(cues), name + '.srt', 'application/x-subrip');
    state.transcribeStatus = 'done: ' + (msg.text || '').length + ' 字符，' + cues.length + ' 条时间轴';
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

  // ---- popup messaging ------------------------------------------------------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    if (msg.type === 'status') {
      sendResponse({
        videos: listVideos().length,
        masters: Object.keys(state.masterPlaylists).length,
        vttSegments: Object.keys(state.vttSegments).length,
        recording: state.recording,
        transcribeStatus: state.transcribeStatus
      });
      return true;
    }

    if (msg.type === 'transcribe-progress') {
      var stages = {
        'decoding': '解码音频…',
        'loading-model': '加载语音模型…',
        'downloading-model': '下载模型 ' + (msg.detail || ''),
        'transcribing': '识别中…'
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
          sendResponse({ ok: false, error: '未捕获到字幕。请在视频上开启字幕(CC)并播放一会，然后重试。' });
          return;
        }
        var fmt = msg.format || 'srt';
        var name = 'twitter-subtitles-' + tsName() + '.' + fmt;
        var mime = fmt === 'vtt' ? 'text/vtt' : fmt === 'txt' ? 'text/plain' : 'application/x-subrip';
        downloadText(res[fmt] || res.srt, name, mime);
        sendResponse({ ok: true, count: res.count });
      }).catch(function (e) {
        sendResponse({ ok: false, error: '抓取字幕出错：' + e.message });
      });
      return true; // async
    }

    if (msg.type === 'start-audio') {
      sendResponse(startAudio({ transcribe: msg.transcribe, lang: msg.lang }));
      return true;
    }

    if (msg.type === 'stop-audio') {
      sendResponse(stopAudio());
      return true;
    }
  });
})();
