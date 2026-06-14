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
    live: null             // live (real-time) transcription session, see startLive()
  };

  // Live transcription: transcribe consecutive, non-overlapping ~6s windows so
  // text appears every few seconds and concatenates cleanly (no overlap dedup).
  var LIVE_WINDOW_SEC = 6;

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
      downloadBlob(blob, siteName() + '-audio-' + tsName() + '.' + ext);
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
    state.transcribeStatus = 'done: ' + (msg.text || '').length + ' 字符，' + cues.length + ' 条时间轴';
  }

  function stopAudio() {
    if (!state.recording || !state.recorder) return { ok: false, error: '当前没有录制任务。' };
    try { state.recorder.stop(); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true };
  }

  // ---- live (real-time) transcription ---------------------------------------
  // Continuously pull the playing video's audio through WebAudio, slice it into
  // overlapping windows, and stream each window to the offscreen Whisper. Text
  // flows back chunk-by-chunk and is appended live; on stop we save .txt/.srt.
  function startLive(opts) {
    opts = opts || {};
    if (state.live) return { ok: false, error: '实时转写已在进行中。' };
    if (state.recording) return { ok: false, error: '正在录制音频，请先停止。' };

    var video = pickVideo();
    if (!video) return { ok: false, error: '页面上没有找到视频。请先播放一个视频。' };
    var capture = video.captureStream || video.mozCaptureStream;
    if (!capture) return { ok: false, error: '当前浏览器不支持 captureStream。' };

    var stream;
    try { stream = capture.call(video); }
    catch (e) { return { ok: false, error: '无法捕获媒体流：' + e.message }; }
    var audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      return { ok: false, error: '该视频没有音轨，或音轨尚未就绪（请确保视频正在播放且未静音）。' };
    }

    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return { ok: false, error: '当前浏览器不支持 AudioContext。' };

    var ac, source, proc, sink;
    try {
      ac = new AC();
      source = ac.createMediaStreamSource(new MediaStream(audioTracks));
      proc = ac.createScriptProcessor(4096, 1, 1);
      // A zero-gain sink keeps the graph "pulling" audio (so onaudioprocess
      // fires) without re-playing the captured sound through the speakers.
      sink = ac.createGain();
      sink.gain.value = 0;
      source.connect(proc);
      proc.connect(sink);
      sink.connect(ac.destination);
    } catch (e) {
      try { if (ac) ac.close(); } catch (_) {}
      return { ok: false, error: '无法初始化音频处理：' + e.message };
    }

    var rate = ac.sampleRate;
    var winSamples = Math.round(LIVE_WINDOW_SEC * rate);
    var firstSamples = Math.round(3 * rate); // emit a first (partial) window after ~3s
    var pending = [];        // FIFO of captured Float32 blocks awaiting a window
    var pendingLen = 0;      // total samples queued in `pending`
    var emittedSamples = 0;  // absolute samples already emitted (for timestamps)
    var totalSamples = 0;    // total samples captured
    var firstDone = false;
    var seq = 0;

    var live = {
      ac: ac, source: source, proc: proc, sink: sink,
      lang: opts.lang || 'auto',
      model: opts.model || state.model,
      cues: [],
      text: '',
      stopping: false,
      windows: 0,      // audio windows sent for transcription
      results: 0,      // results received back
      maxLevel: 0,     // peak |sample| seen (to detect silence)
      lastError: '',
      emit: flush
    };

    // Assemble `want` samples from the FIFO into one window and send it.
    function drain(want) {
      if (want <= 0 || pendingLen < want) return;
      var win = new Float32Array(want);
      var off = 0;
      while (off < want && pending.length) {
        var blk = pending[0];
        var need = want - off;
        if (blk.length <= need) { win.set(blk, off); off += blk.length; pending.shift(); }
        else { win.set(blk.subarray(0, need), off); off += need; pending[0] = blk.subarray(need); }
      }
      pendingLen -= want;
      var windowStartMs = Math.round(emittedSamples / rate * 1000);
      emittedSamples += want;
      var pcm16k = T.resampleLinear(win, rate, 16000);
      if (pcm16k.length < 16000 * 0.3) return; // <0.3s, skip
      var i16 = T.floatToInt16(pcm16k);
      live.windows++;
      chrome.runtime.sendMessage({
        type: 'transcribe-chunk',
        seq: seq++,
        b64: T.u8ToBase64(new Uint8Array(i16.buffer)),
        sampleRate: 16000,
        windowStartMs: windowStartMs,
        windowDurationMs: Math.round(pcm16k.length / 16000 * 1000),
        lang: live.lang,
        model: live.model
      }).catch(function () {});
    }

    // Flush whatever remains (called on stop).
    function flush() { if (pendingLen > 0) drain(pendingLen); }

    proc.onaudioprocess = function (e) {
      var input = e.inputBuffer.getChannelData(0);
      var n = input.length;
      var copy = new Float32Array(n);
      copy.set(input);                       // inputBuffer is reused; copy it out
      // Track peak level so we can tell "silence" from "model failed" later.
      for (var k = 0; k < n; k += 64) {
        var a = copy[k] < 0 ? -copy[k] : copy[k];
        if (a > live.maxLevel) live.maxLevel = a;
      }
      pending.push(copy);
      pendingLen += n;
      totalSamples += n;
      // First window early for snappier feedback, then full non-overlapping ones.
      if (!firstDone && pendingLen >= firstSamples) {
        firstDone = true;
        drain(Math.min(pendingLen, winSamples));
      }
      while (pendingLen >= winSamples) drain(winSamples);
    };

    state.live = live;
    state.lang = live.lang;
    state.model = live.model;
    state.transcribeStatus = 'live: 正在聆听…（首次需加载语音模型）';

    // AudioContext is often created "suspended" under the autoplay policy; if it
    // stays suspended no audio is processed and we'd capture nothing. Resume it,
    // and warn if it refuses (the page may need a click first).
    function checkRunning() {
      if (!state.live || state.live !== live) return;
      if (ac.state !== 'running') {
        state.transcribeStatus = 'live: 音频未启动，请点击网页（视频）任意位置后重试…';
      }
    }
    if (ac.state === 'suspended' && ac.resume) {
      ac.resume().then(checkRunning).catch(checkRunning);
    } else {
      setTimeout(checkRunning, 1200);
    }
    return { ok: true };
  }

  function onLiveChunkResult(msg) {
    var live = state.live;
    if (!live) return;
    live.results++;
    if (!msg.ok) {
      // Keep going on a single failed window, but remember the latest error.
      live.lastError = msg.error || '未知错误';
      state.transcribeStatus = 'live: 识别出错（' + live.lastError + '），继续聆听…';
      return;
    }
    // Windows are non-overlapping, so the recognized text is the source of truth
    // (appended directly); chunks are used only to time-stamp the .srt. If a
    // window yields text but no usable chunk timestamps, synthesize one cue so
    // the text is never lost from either the live view or the subtitles.
    var txt = String(msg.text || '').trim();
    var winStart = msg.windowStartMs || 0;
    var winCues = T.shiftCues(T.whisperChunksToCues(msg.chunks, msg.windowDurationMs), winStart);
    if (!winCues.length && txt) {
      winCues = [{ start: winStart, end: winStart + (msg.windowDurationMs || 2000), text: txt }];
    }
    if (winCues.length) live.cues = live.cues.concat(winCues);
    if (txt) live.text = live.text ? (live.text + ' ' + txt) : txt;
    state.transcribeStatus = 'live: ' + (live.text || '（聆听中，暂无文字…）');
  }

  // Explain an empty result so the user knows what to fix.
  function liveDiagnosis(live) {
    if (live.windows === 0) {
      return '没有采集到音频。请确认视频正在播放、未静音，并已在网页上点击过一次；' +
        '受 DRM 保护的视频无法捕获。';
    }
    if (live.maxLevel < 0.002) {
      return '采集到的音频几乎是静音（峰值≈0）。请取消视频静音、调高音量后重试。';
    }
    if (live.results === 0) {
      return '语音模型未返回结果，可能仍在下载模型（首次约 40MB）或网络受限，请稍后重试。';
    }
    if (live.lastError) {
      return '转写器报错：' + live.lastError + '（常见为语音模型下载失败，请检查网络后重试）。';
    }
    return '音频有声音但未识别出文字，可能是纯音乐/噪声，或可尝试在“识别语言”中手动指定语言。';
  }

  function stopLive() {
    var live = state.live;
    if (!live || live.stopping) return { ok: false, error: '当前没有实时转写任务。' };
    live.stopping = true;
    try { live.emit(true); } catch (e) {}          // flush the trailing window
    try { live.proc.onaudioprocess = null; } catch (e) {}
    try { live.proc.disconnect(); } catch (e) {}
    try { live.source.disconnect(); } catch (e) {}
    try { live.sink.disconnect(); } catch (e) {}
    try { live.ac.close(); } catch (e) {}
    state.transcribeStatus = 'live: 正在生成文件…';
    // Give the last in-flight window(s) a moment to come back before saving.
    setTimeout(function () {
      if (live.text) {
        var name = siteName() + '-live-transcript-' + tsName();
        downloadText(live.text, name + '.txt', 'text/plain');
        if (live.cues.length) {
          var ordered = live.cues.slice().sort(function (a, b) { return a.start - b.start; });
          downloadText(Vtt.toSrt(ordered), name + '.srt', 'application/x-subrip');
        }
        state.transcribeStatus = 'done: 实时转写 ' + live.text.length +
          ' 字符，' + live.cues.length + ' 条字幕（.txt/.srt 已下载）';
      } else {
        // Nothing recognized: surface a concrete reason instead of a bare file.
        state.transcribeStatus = 'error: 未识别到文字。' + liveDiagnosis(live);
      }
      state.live = null;
    }, 4000);
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
        live: !!state.live,
        liveText: state.live ? state.live.text : '',
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

    if (msg.type === 'transcribe-chunk-result') {
      onLiveChunkResult(msg);
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

    if (msg.type === 'start-live') {
      sendResponse(startLive({ lang: msg.lang, model: msg.model }));
      return true;
    }

    if (msg.type === 'stop-live') {
      sendResponse(stopLive());
      return true;
    }
  });
})();
