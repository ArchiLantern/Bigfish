'use strict';
/**
 * afterPack hook: embed the Bigfish icon + version metadata into the Windows
 * executable ourselves, because electron-builder's built-in rcedit step needs
 * the winCodeSign archive whose macOS dylib symlinks fail to extract on a
 * Windows box without Developer Mode. The standalone rcedit binary is bundled
 * in build/ and does the same job without touching those macOS files.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }
  const rcedit = path.join(__dirname, 'build', 'rcedit-x64.exe');
  const icon = path.join(__dirname, 'build', 'icon.ico');
  if (!fs.existsSync(rcedit) || !fs.existsSync(icon)) {
    console.log('[afterPack] rcedit or icon missing, skipping exe edit');
    return;
  }
  const exe = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe');
  const version = (require('./package.json').version || '0.1.0').split('-')[0] + '.0';
  execFileSync(
    rcedit,
    [
      exe,
      '--set-icon', icon,
      '--set-version-string', 'ProductName', 'Bigfish',
      '--set-version-string', 'FileDescription', 'Bigfish',
      '--set-version-string', 'CompanyName', 'Bigfish',
      '--set-file-version', version,
      '--set-product-version', version,
    ],
    { stdio: 'inherit' },
  );
  console.log('[afterPack] applied icon + version to', exe);
};
