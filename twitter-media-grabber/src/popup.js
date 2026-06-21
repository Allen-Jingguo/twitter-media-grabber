'use strict';

var $ = function (id) { return document.getElementById(id); };

function setMsg(text, kind) {
  var el = $('msg');
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

function activeTab() {
  return new Promise(function (resolve, reject) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab) return reject(new Error('没有活动标签页'));
      if (!/^https?:\/\//.test(tab.url || '')) {
        return reject(new Error('请在普通网页（http/https）上使用本插件。'));
      }
      resolve(tab);
    });
  });
}

// Content scripts, in load order. Mirrors manifest.json so we can inject them
// on demand into tabs that were already open before the extension loaded.
var MAIN_SCRIPTS = ['src/inject.js'];
var ISOLATED_SCRIPTS = ['src/lib/vtt.js', 'src/lib/m3u8.js', 'src/lib/transcript.js', 'src/content.js'];

function rawSend(tabId, msg) {
  return new Promise(function (resolve, reject) {
    chrome.tabs.sendMessage(tabId, msg, function (resp) {
      var err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(resp);
    });
  });
}

// Programmatically inject the content scripts (used when a tab predates the
// extension and therefore has no receiver yet).
function injectContentScripts(tabId) {
  function exec(files, world) {
    return chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: false },
      files: files,
      world: world,
      injectImmediately: true
    });
  }
  return exec(MAIN_SCRIPTS, 'MAIN').then(function () {
    return exec(ISOLATED_SCRIPTS, 'ISOLATED');
  });
}

function send(tabId, msg) {
  return rawSend(tabId, msg).catch(function (err) {
    // "Receiving end does not exist" => no content script yet. Inject and retry.
    if (!/Receiving end does not exist|Could not establish connection/i.test(err.message)) {
      throw new Error(err.message + '（请刷新页面后重试）');
    }
    if (!chrome.scripting || !chrome.scripting.executeScript) {
      throw new Error('页面尚未就绪，请刷新页面后重试。');
    }
    return injectContentScripts(tabId).then(function () {
      return rawSend(tabId, msg);
    }).catch(function (e2) {
      throw new Error('无法在此页面运行（可能是受限页面）：' + e2.message);
    });
  });
}

function renderTranscribeStatus(st) {
  var el = $('st-transcribe');
  st = st || '';
  el.className = 'tstatus';
  if (!st) { el.textContent = ''; return; }
  if (st.indexOf('error:') === 0) {
    el.classList.add('err');
    el.textContent = '转写失败：' + st.slice(6).trim();
  } else if (st.indexOf('done:') === 0) {
    el.classList.add('done');
    el.textContent = st.slice(5).trim();
  } else if (st.indexOf('working:') === 0) {
    el.textContent = '转写中：' + st.slice(8).trim();
  } else if (st.indexOf('live:') === 0) {
    el.textContent = st.slice(5).trim();
  } else {
    el.textContent = '等待录制结束后开始转写…';
  }
}

// Live transcription state lives in the background service worker (it keeps
// running while the popup is closed), so query it there, not in the content script.
function bgSend(msg) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(msg, function (resp) {
      var err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(resp);
    });
  });
}

function refreshLive() {
  bgSend({ type: 'live-status' }).then(function (s) {
    if (!s) return;
    var box = $('live-box');
    $('btn-live-start').disabled = !!s.active;
    $('btn-live-stop').disabled = !s.active;
    if (s.active) {
      box.hidden = false;
      box.textContent = s.text || '正在聆听…（首次需加载语音模型，请稍候）';
      box.scrollTop = box.scrollHeight;
    } else if (s.text) {
      box.hidden = false;
      box.textContent = s.text;
    }
    if (s.error) renderTranscribeStatus('error: ' + s.error);
    else if (s.status && s.status.indexOf('done:') === 0) renderTranscribeStatus(s.status);
    else if (s.active) renderTranscribeStatus('live: ' + (s.text ? '识别中…' : '正在聆听…'));
  }).catch(function () {});
}

function refreshStatus() {
  activeTab().then(function (tab) {
    return send(tab.id, { type: 'status' });
  }).then(function (s) {
    if (!s) return;
    $('st-videos').textContent = s.videos;
    $('st-masters').textContent = s.masters;
    $('st-vtt').textContent = s.vttSegments;
    $('btn-audio-start').disabled = !!s.recording;
    $('btn-audio-stop').disabled = !s.recording;
    if (s.recording) setMsg('正在录制音频…', 'ok');
  }).catch(function (e) { /* content not ready on this tab; live still works */ });
  refreshLive();
}

// Keep status / live text fresh while the popup stays open.
setInterval(refreshStatus, 1000);

$('btn-subs').addEventListener('click', function () {
  var fmt = $('sub-format').value;
  setMsg('正在抓取字幕…');
  activeTab().then(function (tab) {
    return send(tab.id, { type: 'grab-subtitles', format: fmt });
  }).then(function (res) {
    if (res && res.ok) setMsg('已下载 ' + res.count + ' 条字幕。', 'ok');
    else setMsg((res && res.error) || '抓取失败。', 'err');
  }).catch(function (e) { setMsg(e.message, 'err'); });
});

$('btn-audio-start').addEventListener('click', function () {
  setMsg('正在启动录制…');
  activeTab().then(function (tab) {
    return send(tab.id, {
      type: 'start-audio',
      transcribe: $('opt-transcribe').checked,
      lang: $('opt-lang').value,
      model: $('opt-model').value
    });
  }).then(function (res) {
    if (res && res.ok) {
      setMsg('录制中… 完成后点“停止并下载”。', 'ok');
      $('btn-audio-start').disabled = true;
      $('btn-audio-stop').disabled = false;
    } else {
      setMsg((res && res.error) || '无法开始录制。', 'err');
    }
  }).catch(function (e) { setMsg(e.message, 'err'); });
});

$('btn-audio-stop').addEventListener('click', function () {
  activeTab().then(function (tab) {
    return send(tab.id, { type: 'stop-audio' });
  }).then(function (res) {
    if (res && res.ok) {
      setMsg('已停止，音频文件正在下载。', 'ok');
      $('btn-audio-start').disabled = false;
      $('btn-audio-stop').disabled = true;
    } else {
      setMsg((res && res.error) || '停止失败。', 'err');
    }
  }).catch(function (e) { setMsg(e.message, 'err'); });
});

$('btn-live-start').addEventListener('click', function () {
  setMsg('正在启动实时转写…');
  $('live-box').hidden = false;
  $('live-box').textContent = '正在聆听…（首次需加载语音模型，请稍候）';
  $('btn-live-start').disabled = true;
  $('btn-live-stop').disabled = false;
  activeTab().then(function (tab) {
    // Live capture grabs the *tab's* audio output in the background worker, so
    // it works even where the page protects the media (e.g. Douyin).
    return bgSend({ type: 'live-start', tabId: tab.id, lang: $('opt-lang').value, model: $('opt-model').value });
  }).then(function (res) {
    if (res && res.ok) setMsg('实时转写已开始，文字会随播放滚动出现。', 'ok');
    else { setMsg((res && res.error) || '无法开始实时转写。', 'err'); $('btn-live-start').disabled = false; $('btn-live-stop').disabled = true; }
  }).catch(function (e) { setMsg(e.message, 'err'); $('btn-live-start').disabled = false; $('btn-live-stop').disabled = true; });
});

$('btn-live-stop').addEventListener('click', function () {
  bgSend({ type: 'live-stop' }).then(function (res) {
    if (res && res.ok) {
      setMsg('已停止，正在生成 .txt / .srt …', 'ok');
      $('btn-live-stop').disabled = true;
    } else {
      setMsg((res && res.error) || '停止失败。', 'err');
    }
  }).catch(function (e) { setMsg(e.message, 'err'); });
});

document.addEventListener('DOMContentLoaded', refreshStatus);
refreshStatus();
