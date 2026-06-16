/*
 * Service worker. Owns the offscreen transcriber document and the live
 * transcription session.
 *
 * Batch ("record -> transcribe"):
 *   content --'transcribe-audio'--> bg --'offscreen-transcribe'--> offscreen
 *   offscreen --'transcribe-progress'/'transcribe-result'--> bg --> tab
 *
 * Live (real-time): audio is captured from the *tab* (works on cross-origin /
 * protected players where video.captureStream() is silent). The popup drives it:
 *   popup --'live-start'--> bg: getMediaStreamId + ensureOffscreen
 *                              --'offscreen-live-start'(streamId)--> offscreen
 *   offscreen --'live-progress'/'live-done'--> bg (keeps liveSession; popup polls
 *   'live-status'). On 'live-done' bg saves the .txt/.srt via chrome.downloads.
 */
'use strict';

var OFFSCREEN_URL = 'src/offscreen.html';

// Snapshot of the live session for the popup to poll (the popup may be closed
// while transcription runs, so state lives here, not in the popup).
var liveSession = { active: false, status: '', text: '', error: '', done: false, tabId: null };

function ensureOffscreen() {
  return chrome.offscreen.hasDocument().then(function (has) {
    if (has) return;
    return chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture tab audio and transcribe it locally with Whisper.'
    }).catch(function (e) {
      if (!/single offscreen/i.test(String(e && e.message))) throw e;
    });
  });
}

function tsName() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function dataUrl(text, mime) {
  return 'data:' + (mime || 'text/plain') + ';charset=utf-8,' + encodeURIComponent(text || '');
}

function saveText(text, filename, mime) {
  chrome.downloads.download({ url: dataUrl(text, mime), filename: filename, saveAs: false })
    .catch(function () {});
}

function siteFromUrl(url) {
  try {
    var h = new URL(url).hostname.replace(/^www\./, '');
    return h.replace(/[^a-zA-Z0-9.-]/g, '') || 'video';
  } catch (e) { return 'video'; }
}

function startLive(msg) {
  liveSession = { active: true, status: 'starting', text: '', error: '', done: false, tabId: msg.tabId };
  ensureOffscreen()
    .then(function () { return chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId }); })
    .then(function (streamId) {
      liveSession.status = 'listening';
      return chrome.runtime.sendMessage({
        type: 'offscreen-live-start',
        streamId: streamId,
        lang: msg.lang,
        model: msg.model,
        tabId: msg.tabId
      });
    })
    .catch(function (e) {
      liveSession.active = false;
      liveSession.done = true;
      liveSession.error = '无法开始实时转写：' + String((e && e.message) || e);
    });
}

function stopLive() {
  liveSession.status = 'finishing';
  chrome.runtime.sendMessage({ type: 'offscreen-live-stop' }).catch(function () {});
}

function finishLive(msg) {
  liveSession.active = false;
  liveSession.done = true;
  liveSession.text = msg.text || '';
  if (msg.error) liveSession.error = msg.error;

  var tabId = liveSession.tabId;
  var done = function (site) {
    if (msg.text) {
      var base = site + '-live-transcript-' + tsName();
      saveText(msg.text, base + '.txt', 'text/plain');
      if (msg.srt) saveText(msg.srt, base + '.srt', 'application/x-subrip');
      liveSession.status = 'done: ' + msg.text.length + ' 字符，' + (msg.cues || 0) + ' 条字幕（.txt/.srt 已下载）';
    } else {
      liveSession.status = '';
      if (!liveSession.error) {
        liveSession.error = '未识别到文字。' + (
          (msg.windows || 0) === 0 ? '没有采集到标签页音频（页面是否在播放声音？）。'
          : (msg.maxLevel || 0) < 0.002 ? '采集到的音频几乎是静音，请取消静音/调高音量。'
          : (msg.results || 0) === 0 ? '语音模型未返回结果，可能仍在下载（首次）或网络受限。'
          : '音频有声音但未识别出文字，可尝试指定语言或换更大模型。'
        );
      }
    }
  };
  if (tabId != null) {
    chrome.tabs.get(tabId).then(function (t) { done(siteFromUrl(t.url || '')); })
      .catch(function () { done('video'); });
  } else { done('video'); }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'transcribe-audio') {
    var tabId = sender.tab && sender.tab.id;
    ensureOffscreen().then(function () {
      return chrome.runtime.sendMessage({
        type: 'offscreen-transcribe',
        tabId: tabId, b64: msg.b64, mime: msg.mime, lang: msg.lang, model: msg.model
      });
    }).catch(function (e) {
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, {
          type: 'transcribe-result', ok: false,
          error: '无法启动转写器：' + String((e && e.message) || e)
        }).catch(function () {});
      }
    });
    return;
  }

  if (msg.type === 'transcribe-progress' || msg.type === 'transcribe-result') {
    if (msg.tabId != null) chrome.tabs.sendMessage(msg.tabId, msg).catch(function () {});
    return;
  }

  // ---- live transcription control / status ----
  if (msg.type === 'live-start') { startLive(msg); sendResponse({ ok: true }); return true; }
  if (msg.type === 'live-stop') { stopLive(); sendResponse({ ok: true }); return true; }
  if (msg.type === 'live-status') { sendResponse(liveSession); return true; }
  if (msg.type === 'live-progress') {
    if (liveSession.active) {
      if (typeof msg.text === 'string') liveSession.text = msg.text;
      if (msg.error) liveSession.error = msg.error;
      liveSession.maxLevel = msg.maxLevel;
      liveSession.windows = msg.windows;
      liveSession.results = msg.results;
    }
    return;
  }
  if (msg.type === 'live-done') { finishLive(msg); return; }
});
