'use strict';
/*
 * Static validation that doesn't need a browser:
 *  - manifest.json is valid JSON and references files that exist
 *  - every .js file under the extension parses (node --check)
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var root = path.join(__dirname, '..');
var errors = [];
var checks = 0;

function ok(cond, msg) {
  checks++;
  if (cond) { console.log('  ✓ ' + msg); }
  else { console.log('  ✗ ' + msg); errors.push(msg); }
}

console.log('Manifest + assets');

var manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  ok(true, 'manifest.json is valid JSON');
} catch (e) {
  ok(false, 'manifest.json is valid JSON (' + e.message + ')');
}

if (manifest) {
  ok(manifest.manifest_version === 3, 'manifest_version is 3');

  var referenced = [];
  if (manifest.action && manifest.action.default_popup) referenced.push(manifest.action.default_popup);
  if (manifest.background && manifest.background.service_worker) referenced.push(manifest.background.service_worker);
  (manifest.content_scripts || []).forEach(function (cs) {
    (cs.js || []).forEach(function (j) { referenced.push(j); });
  });
  Object.keys(manifest.icons || {}).forEach(function (k) { referenced.push(manifest.icons[k]); });

  referenced.forEach(function (rel) {
    ok(fs.existsSync(path.join(root, rel)), 'referenced file exists: ' + rel);
  });

  // popup.html assets
  var popupHtml = fs.readFileSync(path.join(root, manifest.action.default_popup), 'utf8');
  ['popup.js', 'popup.css'].forEach(function (asset) {
    ok(popupHtml.indexOf(asset) !== -1, 'popup.html references ' + asset);
  });

  // Both worlds present for the content scripts.
  var worlds = (manifest.content_scripts || []).map(function (c) { return c.world; });
  ok(worlds.indexOf('MAIN') !== -1 && worlds.indexOf('ISOLATED') !== -1,
    'content scripts declare both MAIN and ISOLATED worlds');

  // Works on any site: every content script matches generic http/https.
  var allGeneric = (manifest.content_scripts || []).every(function (c) {
    return (c.matches || []).indexOf('https://*/*') !== -1 &&
           (c.matches || []).indexOf('http://*/*') !== -1;
  });
  ok(allGeneric, 'content scripts match all http/https sites');

  // Transcription (offscreen + Whisper) requirements.
  ok((manifest.permissions || []).indexOf('offscreen') !== -1, 'has "offscreen" permission');
  var csp = (manifest.content_security_policy || {}).extension_pages || '';
  ok(csp.indexOf('wasm-unsafe-eval') !== -1, "CSP allows 'wasm-unsafe-eval' (needed by onnxruntime)");
  ['src/offscreen.html', 'src/offscreen.js', 'src/lib/transcript.js',
   'src/vendor/transformers.min.js',
   'src/vendor/ort-wasm-simd-threaded.jsep.mjs',
   'src/vendor/ort-wasm-simd-threaded.jsep.wasm'].forEach(function (rel) {
    ok(fs.existsSync(path.join(root, rel)), 'transcriber file exists: ' + rel);
  });
  var offscreenHtml = fs.readFileSync(path.join(root, 'src/offscreen.html'), 'utf8');
  ok(offscreenHtml.indexOf('lib/transcript.js') !== -1 && offscreenHtml.indexOf('offscreen.js') !== -1,
    'offscreen.html loads transcript.js + offscreen.js');
}

console.log('\nJavaScript syntax (node --check)');
function walk(dir, list) {
  fs.readdirSync(dir).forEach(function (name) {
    var p = path.join(dir, name);
    var st = fs.statSync(p);
    if (st.isDirectory()) {
      // vendor/ holds prebuilt third-party bundles; don't lint those.
      if (name !== 'node_modules' && name !== 'vendor') walk(p, list);
    } else if (/\.js$/.test(name)) list.push(p);
  });
  return list;
}
var os = require('os');
walk(path.join(root, 'src'), []).forEach(function (file) {
  try {
    var src = fs.readFileSync(file, 'utf8');
    // node --check assumes CommonJS for .js; copy ESM files to a temp .mjs.
    var isEsm = /^\s*(import|export)\s/m.test(src);
    var target = file;
    if (isEsm) {
      target = path.join(os.tmpdir(), 'tmg-' + path.basename(file, '.js') + '.mjs');
      fs.writeFileSync(target, src);
    }
    cp.execSync('node --check ' + JSON.stringify(target), { stdio: 'pipe' });
    ok(true, 'parses: ' + path.relative(root, file) + (isEsm ? ' (esm)' : ''));
  } catch (e) {
    ok(false, 'parses: ' + path.relative(root, file) + ' (' + String(e.stderr || e.message).split('\n')[0] + ')');
  }
});

console.log('\n' + (checks - errors.length) + ' passed, ' + errors.length + ' failed');
if (errors.length) process.exitCode = 1;
