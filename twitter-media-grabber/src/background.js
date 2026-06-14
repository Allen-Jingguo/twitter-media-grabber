/*
 * Service worker. Creates/keeps the offscreen transcriber document and routes
 * messages between the content script (which records audio in the page) and
 * the offscreen document (which runs Whisper locally):
 *
 *   content --'transcribe-audio'--> background --'offscreen-transcribe'--> offscreen
 *   offscreen --'transcribe-progress'/'transcribe-result'--> background --> tab
 */
'use strict';

var OFFSCREEN_URL = 'src/offscreen.html';

function ensureOffscreen() {
  return chrome.offscreen.hasDocument().then(function (has) {
    if (has) return;
    return chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Decode captured tab audio and transcribe it locally with Whisper.'
    }).catch(function (e) {
      // A parallel call may have created it between hasDocument() and here.
      if (!/single offscreen/i.test(String(e && e.message))) throw e;
    });
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || !msg.type) return;

  if (msg.type === 'transcribe-audio') {
    var tabId = sender.tab && sender.tab.id;
    ensureOffscreen().then(function () {
      return chrome.runtime.sendMessage({
        type: 'offscreen-transcribe',
        tabId: tabId,
        b64: msg.b64,
        mime: msg.mime,
        lang: msg.lang,
        model: msg.model
      });
    }).catch(function (e) {
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, {
          type: 'transcribe-result',
          ok: false,
          error: '无法启动转写器：' + String((e && e.message) || e)
        }).catch(function () {});
      }
    });
    return;
  }

  // Live transcription: forward each audio window to the offscreen worker.
  if (msg.type === 'transcribe-chunk') {
    var chunkTab = sender.tab && sender.tab.id;
    ensureOffscreen().then(function () {
      return chrome.runtime.sendMessage({
        type: 'offscreen-transcribe-chunk',
        tabId: chunkTab,
        seq: msg.seq,
        b64: msg.b64,
        sampleRate: msg.sampleRate,
        windowStartMs: msg.windowStartMs,
        windowDurationMs: msg.windowDurationMs,
        lang: msg.lang,
        model: msg.model,
        final: msg.final
      });
    }).catch(function (e) {
      if (chunkTab != null) {
        chrome.tabs.sendMessage(chunkTab, {
          type: 'transcribe-chunk-result',
          ok: false,
          seq: msg.seq,
          error: '无法启动转写器：' + String((e && e.message) || e)
        }).catch(function () {});
      }
    });
    return;
  }

  if (msg.type === 'transcribe-progress' ||
      msg.type === 'transcribe-result' ||
      msg.type === 'transcribe-chunk-result') {
    if (msg.tabId != null) {
      chrome.tabs.sendMessage(msg.tabId, msg).catch(function () {});
    }
  }
});
