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

function send(tabId, msg) {
  return new Promise(function (resolve, reject) {
    chrome.tabs.sendMessage(tabId, msg, function (resp) {
      var err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message + '（请刷新页面后重试）'));
      resolve(resp);
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
    el.textContent = '转写完成：' + st.slice(5).trim() + '（.txt/.srt 已下载）';
  } else if (st.indexOf('working:') === 0) {
    el.textContent = '转写中：' + st.slice(8).trim();
  } else {
    el.textContent = '等待录制结束后开始转写…';
  }
}

function renderLive(s) {
  var box = $('live-box');
  $('btn-live-start').disabled = !!s.live || !!s.recording;
  $('btn-live-stop').disabled = !s.live;
  if (s.live) {
    box.hidden = false;
    box.textContent = s.liveText || '正在聆听…（首次需加载语音模型，请稍候）';
    box.scrollTop = box.scrollHeight;
  } else if (!box.textContent) {
    box.hidden = true;
  }
}

function refreshStatus() {
  activeTab().then(function (tab) {
    return send(tab.id, { type: 'status' });
  }).then(function (s) {
    if (!s) return;
    $('st-videos').textContent = s.videos;
    $('st-masters').textContent = s.masters;
    $('st-vtt').textContent = s.vttSegments;
    // While live transcription runs, the audio capture stream is busy.
    $('btn-audio-start').disabled = !!s.recording || !!s.live;
    $('btn-audio-stop').disabled = !s.recording;
    if (s.recording) setMsg('正在录制音频…', 'ok');
    renderLive(s);
    renderTranscribeStatus(s.transcribeStatus);
  }).catch(function (e) { setMsg(e.message, 'err'); });
}

// Keep the transcribe status / live text fresh while the popup stays open.
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
      lang: $('opt-lang').value
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
  activeTab().then(function (tab) {
    return send(tab.id, { type: 'start-live', lang: $('opt-lang').value });
  }).then(function (res) {
    if (res && res.ok) {
      setMsg('实时转写已开始，文字会随播放滚动出现。', 'ok');
      $('btn-live-start').disabled = true;
      $('btn-live-stop').disabled = false;
    } else {
      setMsg((res && res.error) || '无法开始实时转写。', 'err');
    }
  }).catch(function (e) { setMsg(e.message, 'err'); });
});

$('btn-live-stop').addEventListener('click', function () {
  activeTab().then(function (tab) {
    return send(tab.id, { type: 'stop-live' });
  }).then(function (res) {
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
