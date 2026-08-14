'use strict';
// Stream-download the Electron 115MB zip to a local temp file, reporting
// progress and any reset, to determine whether a single large download works.
const https = require('https');
const fs = require('fs');

const V = '33.4.11';
const url = `https://cdn.npmmirror.com/binaries/electron/${V}/electron-v${V}-win32-x64.zip`;
const dest = `D:\\PROJECT\\deepseekharness\\.electron-cache\\electron-v${V}-win32-x64.zip`;

fs.mkdirSync('D:\\PROJECT\\deepseekharness\\.electron-cache', { recursive: true });

const start = Date.now();
let total = 0;
let lastReport = 0;

const out = fs.createWriteStream(dest);
const req = https.get(url, { headers: { 'User-Agent': 'electron-download' } }, (res) => {
  console.log(`status: ${res.statusCode}, content-length: ${res.headers['content-length']}`);
  if (res.statusCode >= 300 && res.statusCode < 400) {
    console.log(`redirect to: ${res.headers.location}`);
    res.resume();
    return;
  }
  res.on('data', (chunk) => {
    total += chunk.length;
    if (total - lastReport >= 10 * 1024 * 1024) {
      lastReport = total;
      console.log(`  ${(total / 1048576).toFixed(1)} MB ... ${((Date.now() - start) / 1000).toFixed(1)}s`);
    }
  });
  res.pipe(out);
});

req.on('error', (e) => {
  console.log(`DOWNLOAD ERROR after ${(total / 1048576).toFixed(1)} MB: ${e.code || e.message}`);
  out.destroy();
  process.exitCode = 1;
});

out.on('finish', () => {
  const size = fs.statSync(dest).size;
  console.log(`DONE: ${(size / 1048576).toFixed(1)} MB in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`file: ${dest}`);
});
out.on('error', (e) => {
  console.log(`WRITE ERROR: ${e.code || e.message}`);
  process.exitCode = 1;
});
