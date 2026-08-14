'use strict';
// Download the portable Node.js v24 zip with retry + stall detection.
const https = require('https');
const fs = require('fs');

const V = '24.16.0';
const url = `https://cdn.npmmirror.com/binaries/node/v${V}/node-v${V}-win-x64.zip`;
const dest = `D:\\PROJECT\\deepseekharness\\.electron-cache\\node-v${V}-win-x64.zip`;

fs.mkdirSync('D:\\PROJECT\\deepseekharness\\.electron-cache', { recursive: true });

function attempt(n) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let total = 0;
    let lastReport = 0;
    let lastData = Date.now();
    let stallTimer = null;
    const out = fs.createWriteStream(dest);

    const cleanup = () => {
      if (stallTimer) clearInterval(stallTimer);
    };

    const req = https.get(url, { headers: { 'User-Agent': 'node-download' } }, (res) => {
      console.log(`[attempt ${n}] status: ${res.statusCode}, len: ${res.headers['content-length']}`);
      if (res.statusCode >= 300 && res.statusCode < 400) {
        console.log(`redirect: ${res.headers.location}`);
        res.resume();
        cleanup();
        out.destroy();
        reject(new Error('redirect not followed'));
        return;
      }
      stallTimer = setInterval(() => {
        if (Date.now() - lastData > 30000) {
          console.log('[stall] no data for 30s, aborting');
          req.destroy();
        }
      }, 5000);

      res.on('data', (chunk) => {
        total += chunk.length;
        lastData = Date.now();
        if (total - lastReport >= 5 * 1024 * 1024) {
          lastReport = total;
          console.log(`  ${(total / 1048576).toFixed(1)} MB ... ${((Date.now() - start) / 1000).toFixed(1)}s`);
        }
      });
      res.pipe(out);
    });

    req.on('error', (e) => {
      cleanup();
      out.destroy();
      reject(e);
    });
    out.on('finish', () => {
      cleanup();
      resolve(fs.statSync(dest).size);
    });
    out.on('error', (e) => {
      cleanup();
      reject(e);
    });
  });
}

(async () => {
  for (let n = 1; n <= 3; n++) {
    try {
      const size = await attempt(n);
      console.log(`DONE: ${(size / 1048576).toFixed(1)} MB -> ${dest}`);
      return;
    } catch (e) {
      console.log(`[attempt ${n}] failed: ${e.code || e.message}`);
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      if (n < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.log('ALL ATTEMPTS FAILED');
  process.exit(1);
})();
