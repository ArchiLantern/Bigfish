'use strict';
// Regenerate the pet sprite frames from (already transparent) source PNGs:
// trim transparent padding to the opaque bounding box, resize to a consistent
// height, and write the frames the pet expects in assets/pet/.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'build', 'picture');
const outDir = path.join(__dirname, 'assets', 'pet');
fs.mkdirSync(outDir, { recursive: true });

const TARGET_H = 160;
const ALPHA_T = 16;

const mapping = [
  ['standby.png', 'idle.png'],
  ['eat1_background_removed.png', 'eat-1.png'],
  ['eat2_background_removed.png', 'eat-2.png'],
  ['eat3_background_removed.png', 'eat-3.png'],
  ['eat4_background_removed.png', 'eat-4.png'],
  ['goleft1_background_removed.png', 'walk-left-1.png'],
  ['goleft2_background_removed.png', 'walk-left-2.png'],
  ['goright1_background_removed.png', 'walk-right-1.png'],
  ['goright2_background_removed.png', 'walk-right-2.png'],
  ['sleep_background_removed.png', 'sleep.png'],
];

async function processOne(input, output) {
  const src = path.join(srcDir, input);
  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const c = info.channels;
  const hasAlpha = c === 4;

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * c;
      const a = hasAlpha ? data[i + 3] : 255;
      if (a > ALPHA_T) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    console.log(`${input}: 全透明，跳过`);
    return;
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  await sharp(src)
    .extract({ left: minX, top: minY, width: bw, height: bh })
    .resize({ height: TARGET_H })
    .png()
    .toFile(path.join(outDir, output));
  console.log(`${input}: ${w}x${h} -> ${bw}x${bh} -> 高 ${TARGET_H} -> ${output}`);
}

(async () => {
  for (const [inFile, outFile] of mapping) {
    try {
      await processOne(inFile, outFile);
    } catch (e) {
      console.error(`${inFile} 失败: ${e.message}`);
    }
  }
  console.log('完成');
})();
