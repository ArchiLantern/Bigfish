'use strict';
// Remove the white background from the pet sprite frames:
// flood-fill the near-white background from the borders, trim to the opaque
// bounding box, resize to a consistent height, and emit transparent PNGs.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'build', 'picture');
const outDir = path.join(__dirname, 'assets', 'pet');
fs.mkdirSync(outDir, { recursive: true });

const WHITE_T = 235;
const TARGET_H = 160;

const mapping = [
  ['eat1.jpg', 'eat-1.png'],
  ['eat2.jpg', 'eat-2.png'],
  ['eat3.jpg', 'eat-3.png'],
  ['eat4.jpg', 'eat-4.png'],
  ['goleft1.jpg', 'walk-left-1.png'],
  ['goleft2.jpg', 'walk-left-2.png'],
  ['goright1.jpg', 'walk-right-1.png'],
  ['goright2.jpg', 'walk-right-2.png'],
  ['sleep.jpg', 'sleep.png'],
];

async function processOne(input, output) {
  const img = sharp(input);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;

  // 1. near-white mask
  const isWhite = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    isWhite[i] = (r >= WHITE_T && g >= WHITE_T && b >= WHITE_T) ? 1 : 0;
  }

  // 2. flood-fill from borders
  const visited = new Uint8Array(w * h);
  const queue = [];
  const push = (x, y) => {
    const idx = y * w + x;
    if (isWhite[idx] && !visited[idx]) {
      visited[idx] = 1;
      queue.push(idx);
    }
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (queue.length) {
    const idx = queue.pop();
    const x = idx % w;
    const y = (idx / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }

  // 3. RGBA output + opaque bounding box
  const out = Buffer.alloc(w * h * 4);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      out[o] = data[i * 3];
      out[o + 1] = data[i * 3 + 1];
      out[o + 2] = data[i * 3 + 2];
      if (visited[i]) {
        out[o + 3] = 0;
      } else {
        out[o + 3] = 255;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) {
    console.log(`${output}: 全白，跳过`);
    return;
  }

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  await sharp(out, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: minX, top: minY, width: bw, height: bh })
    .resize({ height: TARGET_H })
    .png()
    .toFile(path.join(outDir, output));
  console.log(`${output}: ${w}x${h} -> 主体 ${bw}x${bh} -> 高 ${TARGET_H}`);
}

(async () => {
  for (const [inFile, outFile] of mapping) {
    try {
      await processOne(path.join(srcDir, inFile), outFile);
    } catch (e) {
      console.error(`${inFile} 失败: ${e.message}`);
    }
  }
  // idle = first eat frame (standing pose)
  try {
    fs.copyFileSync(path.join(outDir, 'eat-1.png'), path.join(outDir, 'idle.png'));
    console.log('生成 idle.png (=eat-1)');
  } catch (e) {
    console.error('idle 复制失败:', e.message);
  }
})();
