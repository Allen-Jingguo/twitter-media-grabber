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
      if (!/^https:\/\/(twitter\.com|x\.com)\//.test(tab.url || '')) {
        return reject(new Error('请在 twitter.com 或 x.com 页面上使用本插件。'));
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
  }).catch(function (e) { setMsg(e.message, 'err'); });
}

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
    return send(tab.id, { type: 'start-audio' });
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

document.addEventListener('DOMContentLoaded', refreshStatus);
refreshStatus();
