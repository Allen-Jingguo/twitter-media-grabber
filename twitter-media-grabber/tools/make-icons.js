'use strict';
// Generates simple solid-color PNG icons (Twitter blue) so the extension loads
// without missing-asset errors. Run: node tools/make-icons.js
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

function crc32(buf) {
  var c, table = crc32.table || (crc32.table = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) {
      c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var typeBuf = Buffer.from(type, 'ascii');
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(size, rgb) {
  var sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor RGB
  // 10,11,12 = compression/filter/interlace = 0
  var raw = Buffer.alloc((size * 3 + 1) * size);
  var o = 0;
  for (var y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (var x = 0; x < size; x++) {
      raw[o++] = rgb[0]; raw[o++] = rgb[1]; raw[o++] = rgb[2];
    }
  }
  var idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

var outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
[16, 48, 128].forEach(function (s) {
  var file = path.join(outDir, 'icon' + s + '.png');
  fs.writeFileSync(file, png(s, [29, 155, 240]));
  console.log('wrote ' + path.relative(path.join(__dirname, '..'), file) + ' (' + s + 'x' + s + ')');
});
