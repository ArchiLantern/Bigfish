'use strict';

/**
 * Bigfish — Electron desktop shell for DeepSeek Harness.
 *
 * Architecture:
 *   1. Find a free localhost port.
 *   2. Spawn the bundled `@deepseek-ai/dsh` CLI in "web" profile as a child
 *      process (this is the same backend that `dsh web` runs).
 *   3. Wait until the backend responds on 127.0.0.1:<port>.
 *   4. Open a native BrowserWindow pointing at that local URL.
 *
 * Desktop-product extras (on top of the plain web shell):
 *   - system tray + global shortcut to summon the window
 *   - minimize-to-tray (closing the window keeps the app alive)
 *   - completion notifications (heuristic: backend writes then goes idle)
 *   - desktop pet (transparent floating window)
 *   - launch at login, and a Windows "Open with Bigfish" context menu
 */

// 防御：ELECTRON_RUN_AS_NODE 是给 dsh 子进程用的。若残留到主进程环境里，
// `electron .` 会以纯 Node 模式运行本文件（require('electron') 返回二进制
// 路径而非 API），给出明确提示而不是诡异的 TypeError。
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('[bigfish] 检测到环境变量 ELECTRON_RUN_AS_NODE=1（通常来自诊断/测试残留）。');
  console.error('[bigfish] 请在当前终端执行: Remove-Item Env:ELECTRON_RUN_AS_NODE （Linux: unset ELECTRON_RUN_AS_NODE），然后重新运行 npm start。');
  process.exit(1);
}

const {
  app, BrowserWindow, shell, dialog, Tray, Menu, globalShortcut,
  nativeImage, Notification, ipcMain, screen,
} = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');

const APP_NAME = 'Bigfish';
const HOST = '127.0.0.1';
// 首次启动可能因杀毒软件扫描 / 依赖初始化较慢，放宽到 180s
const READY_TIMEOUT_MS = 180 * 1000;
const IDLE_NOTIFY_MS = 30 * 1000; // backend quiet for this long after activity => "done"

// 检查更新：从 latest.json 读取最新版本（托盘菜单「检查更新」手动触发）
const UPDATE_JSON_URL = 'https://raw.githubusercontent.com/turtle2209/Bigfish/main/latest.json';

/** @type {import('node:child_process').ChildProcess | null} */
let dshProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let petWindow = null;
/** @type {BrowserWindow | null} */
let welcomeWindow = null;
/** @type {Tray | null} */
let tray = null;
/** @type {number | null} */
let port = null;
let quitting = false;
let completionWatcherTimer = null;
let lastBusyAt = 0;
let notifiedForCycle = false;

// ---------------------------------------------------------------------------
// Settings (persisted to userData/settings.json)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  notifyOnComplete: true,
  launchAtLogin: false,
  petEnabled: true,
  onboardingDone: false,
};
let settings = { ...DEFAULT_SETTINGS };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('[bigfish] failed to save settings:', err);
  }
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, HOST, () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

function dshBinPath() {
  if (app.isPackaged) {
    // The production-only dsh node_modules are bundled via extraResources.
    return path.join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }
  return path.join(app.getAppPath(), 'dsh-bundle', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/** Directory of bundled skills shipped with the app (loaded via DSH_BUNDLED_SKILL_DIR). */
function bundledSkillDir() {
  return path.join(app.getAppPath(), 'bundled-skills');
}

/**
 * 应用自己的 DSH_HOME 目录。
 *
 * 打包版必须用独立目录（userData/dsh-home），不能共用命令行 dsh 的
 * `~/.dsh`：用户本机的 profile 可能引用外部插件（如 link 安装的皮肤，
 * 路径是本机私有目录），一旦失效会导致 dsh 后端启动失败（plugin tree
 * 加载失败）。独立 DSH_HOME 让打包版行为可预测、开箱即用。
 *
 * 开发模式沿用系统默认（~/.dsh），方便复用本机 dsh 配置调试。
 */
function dshHomeOverride() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'dsh-home');
  }
  const env = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : '';
  return env;
}

function resolveRuntime() {
  const bin = dshBinPath();
  const env = { ...process.env, DSH_BUNDLED_SKILL_DIR: bundledSkillDir() };
  const dshHome = dshHomeOverride();
  if (dshHome) env.DSH_HOME = dshHome;
  if (!app.isPackaged) {
    return { command: process.env.DSH_NODE || 'node', args: [bin], env };
  }
  // Electron 41+ 内置 Node ≥24（满足 dsh 的 `^22.19.0 || >=24.0.0`），
  // 用 ELECTRON_RUN_AS_NODE 让 Electron 可执行文件以纯 Node 模式运行 dsh，
  // 不再需要捆绑独立的 node-runtime/。
  // --expose-internals：dsh 的 HMR 服务要访问 Node internal 模块。标准 Node
  // 下靠 node-addon-require-builtin 探测，但该插件在 Electron 定制 Node 下
  // 失败（内部结构差异），必须显式开启此标志（cordis 检测到后走原生
  // require 路径）。注意它是 Node 启动标志，必须放在脚本路径之前。
  return { command: process.execPath, args: ['--expose-internals', bin], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}

function waitForReady(p, timeoutMs = READY_TIMEOUT_MS) {
  const base = `http://${HOST}:${p}`;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`${base}/`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.once('error', retry);
      req.setTimeout(3000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for the backend at ${base}`));
        return;
      }
      setTimeout(attempt, 500);
    };
    attempt();
  });
}

/** Kill any leftover backend processes from a previous session (crash / force quit). */
function cleanupStaleDsh() {
  try {
    if (process.platform === 'win32') {
      // 兼容两种形态：开发版（node.exe）与打包版（ELECTRON_RUN_AS_NODE 下进程名是 Bigfish.exe）
      const script = "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -or $_.Name -like 'Bigfish*.exe') -and $_.CommandLine -like '*dsh/lib/bin.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      spawn('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore', windowsHide: true });
    } else {
      spawn('pkill', ['-f', 'dsh/lib/bin.js'], { stdio: 'ignore' });
    }
  } catch { /* best effort */ }
}

function backendLogPath() {
  return path.join(app.getPath('userData'), 'backend.log');
}

async function startDsh() {
  cleanupStaleDsh();
  await new Promise((r) => setTimeout(r, 1500)); // 给清理留一点时间
  port = await findFreePort();
  const rt = resolveRuntime();
  const args = [...rt.args, '--profile', 'web', '--host', HOST, '--port', String(port)];
  console.log(`[bigfish] starting backend on http://${HOST}:${port}`);
  // 后端输出写入日志文件（GUI 程序没有控制台，出错时靠它诊断）
  let logFd = null;
  try {
    fs.mkdirSync(path.dirname(backendLogPath()), { recursive: true });
    logFd = fs.openSync(backendLogPath(), 'a');
    fs.writeSync(logFd, `\n===== Bigfish backend started ${new Date().toISOString()} =====\n`);
  } catch { /* 日志写不了就算了 */ }
  dshProcess = spawn(rt.command, args, {
    env: rt.env,
    stdio: logFd ? ['ignore', logFd, logFd] : ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  dshProcess.once('error', (err) => console.error('[bigfish] failed to spawn backend:', err));
  // 后端进程提前退出则立即失败，避免傻等满超时（"等几分钟才报错"的体验问题）；
  // 失败原因见 backend.log
  const exitEarly = new Promise((_, reject) => {
    dshProcess.once('exit', (code) => reject(
      new Error(`Backend process exited early (exit code ${code}) — 详见日志：${backendLogPath()}`),
    ));
  });
  await Promise.race([waitForReady(port), exitEarly]);
}

function stopDsh() {
  const child = dshProcess;
  dshProcess = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
function notify(title, body) {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body, icon: appIconPath() }).show();
  } catch (err) {
    console.error('[bigfish] notification failed:', err);
  }
}

const PET_QUOTES = [
  // 人设·打招呼
  '我是深海里的鲸鱼公主，很高兴见到你~',
  '欢迎回来，我的小伙伴！',
  '鲸鱼公主来啦，今天也要一起加油哦！',
  '深海那么大，但我只想陪你~',
  // 人设·撒娇/互动
  '哼，都不理我，我要吐泡泡了~',
  '抱抱我嘛，我可是会喷水的公主！',
  '你忙的时候，我会乖乖在旁边看着你~',
  '我的尾巴会发光，但只有你才看得到哦~',
  // 趣味·小知识（鲸鱼相关）
  '小知识：蓝鲸的心跳每分钟只有 6 次哦~',
  '你知道吗？鲸鱼其实是哺乳动物，不是鱼！',
  '鲸鱼唱歌能传 1600 公里远，我的歌声呢~',
  '座头鲸会跳出海面，像是在跳芭蕾~',
  '小知识：抹香鲸可以潜水 90 分钟不上来！',
  // 趣味·日常生活
  '要不要我帮你把今天的任务列个清单？',
  '查资料、写报告、做 PPT，说一声就行~',
  '记得喝口水休息一下，别太累啦！',
  '作业写完记得检查一遍哦~',
  // 加油打气
  '今天也要元气满满！',
  '你已经很棒了，剩下的事交给我！',
  '别怕麻烦，我一直都在~',
];

function petSay(msg) {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-say', msg);
  }
}

function schedulePetChatter() {
  clearTimeout(chatterTimer);
  chatterTimer = setTimeout(() => {
    if (petWindow && !petWindow.isDestroyed() && petState === 'idle') {
      petSay(PET_QUOTES[Math.floor(Math.random() * PET_QUOTES.length)]);
    }
    schedulePetChatter();
  }, 90000); // 固定 1.5 分钟说一句
}

function uninstall() {
  if (!app.isPackaged) {
    dialog.showMessageBox({ type: 'info', title: APP_NAME, message: '卸载功能只在安装版可用', detail: '请安装打包好的 Bigfish 后再使用卸载。' });
    return;
  }
  const uninstaller = path.join(path.dirname(process.execPath), 'Uninstall Bigfish.exe');
  if (fs.existsSync(uninstaller)) {
    quitting = true;
    spawn(uninstaller, [], { detached: true, stdio: 'ignore' });
    setTimeout(() => app.quit(), 800);
  } else {
    shell.openExternal('ms-settings:appsfeatures');
  }
}

// ---------------------------------------------------------------------------
// 检查更新：托盘菜单手动拉取 latest.json，发现新版本就提示下载
// ---------------------------------------------------------------------------
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    // 开发模式不检查；手动触发时给个提示，避免"点了没反应"
    if (manual) {
      dialog.showMessageBox({ type: 'info', title: APP_NAME, message: '开发模式不检查更新', detail: '只有安装版（打包后）才支持检查更新。' });
    }
    return;
  }
  const req = https.get(UPDATE_JSON_URL, { timeout: 10000 }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return;
    }
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try {
        const info = JSON.parse(body);
        const latest = String(info.version || '');
        const current = app.getVersion();
        if (latest && compareVersions(latest, current) > 0) {
          const url = (info.urls && info.urls[process.platform]) || info.url;
          const choice = dialog.showMessageBoxSync({
            type: 'info',
            title: APP_NAME,
            message: `发现新版本 v${latest}`,
            detail: info.note || '有新版本可用，是否去下载？',
            buttons: ['去下载', '以后再说'],
            defaultId: 0,
          });
          if (choice === 0 && url) shell.openExternal(url);
        } else if (manual) {
          dialog.showMessageBox({ type: 'info', title: APP_NAME, message: '已是最新版本', detail: `当前版本 v${current}` });
        }
      } catch { /* JSON 解析失败就忽略 */ }
    });
  });
  req.on('error', () => { if (manual) notify(APP_NAME, '检查更新失败（网络异常）'); });
  req.setTimeout(10000, () => { req.destroy(); });
}

// Heuristic "task completed" detector: watch DSH_HOME (excluding the static
// profiles/ tree) for writes; after a burst of activity followed by idle, notify.
function dshHome() {
  return dshHomeOverride() || path.join(os.homedir(), '.dsh');
}

// ---------------------------------------------------------------------------
// Onboarding wizard
// ---------------------------------------------------------------------------
function createWelcomeWindow() {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.show();
    welcomeWindow.focus();
    return;
  }
  welcomeWindow = new BrowserWindow({
    width: 520,
    height: 660,
    parent: mainWindow || undefined,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Bigfish 新手向导',
    autoHideMenuBar: true,
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'welcome-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  welcomeWindow.once('ready-to-show', () => {
    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      welcomeWindow.show();
      welcomeWindow.focus();
    }
  });
  welcomeWindow.loadFile(path.join(__dirname, 'welcome.html'));
  welcomeWindow.on('closed', () => { welcomeWindow = null; });
}

function latestMtime(dir, skipNames, out) {
  out = out || { t: 0 };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (skipNames && skipNames.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      latestMtime(full, skipNames, out);
    } else if (e.isFile()) {
      try {
        const t = fs.statSync(full).mtimeMs;
        if (t > out.t) out.t = t;
      } catch { /* ignore */ }
    }
  }
  return out;
}

function startCompletionWatcher() {
  stopCompletionWatcher();
  const skip = new Set(['profiles', 'node_modules']);
  completionWatcherTimer = setInterval(() => {
    if (!settings.notifyOnComplete) return;
    const { t } = latestMtime(dshHome(), skip);
    const now = Date.now();
    if (t > lastBusyAt + 2000 && now - t < 2000) {
      // fresh write => busy
      lastBusyAt = now;
      notifiedForCycle = false;
    } else if (lastBusyAt > 0 && now - lastBusyAt > IDLE_NOTIFY_MS && !notifiedForCycle) {
      notifiedForCycle = true;
      const msg = 'Bigfish 任务已完成';
      notify(msg, '后端已空闲，可以回来看看结果了');
      petSay('任务完成啦！');
    }
  }, 5000);
}

function stopCompletionWatcher() {
  if (completionWatcherTimer) {
    clearInterval(completionWatcherTimer);
    completionWatcherTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------
function appIconPath() {
  const candidates = [
    path.join(__dirname, 'assets', 'icon.png'),
    path.join(__dirname, 'build', 'icon.png'),
    path.join(__dirname, 'build', 'icon.ico'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return undefined;
}
function trayIconPath() {
  const candidates = [
    path.join(__dirname, 'assets', 'tray.png'),
    path.join(__dirname, 'assets', 'icon.png'),
    path.join(__dirname, 'build', 'tray.png'),
    path.join(__dirname, 'build', 'icon.png'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return undefined;
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    icon: appIconPath(),
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0b0f',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      welcomeWindow.show();
      welcomeWindow.focus();
    }
  });

  // Close hides to tray (keeps the backend alive); real quit goes through the tray.
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let origin;
    try { origin = new URL(url).origin; } catch { event.preventDefault(); return; }
    if (origin !== `http://${HOST}:${port}`) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    }
  });

  // 页面加载完成后注入半透明背景
  mainWindow.webContents.on('did-finish-load', () => applyBackground());

  mainWindow.loadURL(`http://${HOST}:${port}`);
}

function toggleMainWindow() {
  ensurePet();
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isVisible()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

// ---------------------------------------------------------------------------
// Desktop pet
// ---------------------------------------------------------------------------
function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) { petWindow.show(); return; }
  petWindow = new BrowserWindow({
    width: 220,
    height: 210,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'pet-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  petWindow.setAlwaysOnTop(true, 'floating');
  // 点击穿透只在 Windows 上可靠；Linux 上开启会导致桌宠点不到
  if (process.platform === 'win32') {
    petWindow.setIgnoreMouseEvents(true, { forward: true });
  }
  petWindow.loadFile(path.join(__dirname, 'pet.html'));
  petWindow.on('closed', () => { petWindow = null; });
}

/** 桌宠启用但窗口没了时，重建它（解决关窗后桌宠消失）。 */
function ensurePet() {
  if (settings.petEnabled && (!petWindow || petWindow.isDestroyed())) {
    createPetWindow();
  }
}

function destroyPetWindow() {
  clearPetTimers();
  if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  petWindow = null;
}

// ---------------------------------------------------------------------------
// Pet state machine (idle / eat / sleep / walk-left / walk-right)
// ---------------------------------------------------------------------------
let petState = 'idle';
let wanderTimer = null;
let sleepTimer = null;
let eatTimer = null;
let moveTimer = null;
let chatterTimer = null;

function clearPetTimers() {
  clearTimeout(wanderTimer);
  clearTimeout(sleepTimer);
  clearTimeout(eatTimer);
  clearTimeout(chatterTimer);
  clearInterval(moveTimer);
  wanderTimer = sleepTimer = eatTimer = moveTimer = chatterTimer = null;
}

function setPetState(state) {
  petState = state;
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-state', state);
  }
}

function scheduleSleep() {
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => {
    if (petState === 'idle') setPetState('sleep');
  }, 120 * 1000); // 2 min idle -> sleep
}

function wakePet() {
  clearTimeout(sleepTimer);
  if (petState === 'sleep') setPetState('idle');
  scheduleSleep();
}

function scheduleWander() {
  clearTimeout(wanderTimer);
  wanderTimer = setTimeout(() => {
    if (petState === 'idle') doWander();
    else scheduleWander();
  }, 15000 + Math.random() * 20000);
}

function doWander() {
  if (!petWindow || petWindow.isDestroyed() || petState !== 'idle') {
    scheduleWander();
    return;
  }
  const dir = Math.random() < 0.5 ? 'left' : 'right';
  const [x, y] = petWindow.getPosition();
  const { workAreaSize } = screen.getPrimaryDisplay();
  const distance = 100 + Math.random() * 180;
  const targetX = dir === 'left' ? x - distance : x + distance;
  const clamped = Math.max(0, Math.min(targetX, workAreaSize.width - 220));
  setPetState('walk-' + dir);
  const startX = x;
  const startTime = Date.now();
  const duration = 1400;
  clearInterval(moveTimer);
  moveTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - startTime) / duration);
    petWindow.setPosition(Math.round(startX + (clamped - startX) * t), y);
    if (t >= 1) {
      clearInterval(moveTimer);
      moveTimer = null;
      setPetState('idle');
      scheduleWander();
    }
  }, 16);
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  const icon = trayIconPath();
  if (icon) {
    tray = new Tray(nativeImage.createFromPath(icon));
  } else {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip(APP_NAME);
  tray.on('click', () => toggleMainWindow());
  rebuildTrayMenu();
}

// ---------------------------------------------------------------------------
// 背景图（默认 + 用户自定义）
// ---------------------------------------------------------------------------
let bgCssKey = null;

function backgroundImagePath() {
  const custom = path.join(app.getPath('userData'), 'custom-background.jpg');
  return fs.existsSync(custom) ? custom : path.join(__dirname, 'assets', 'background.jpg');
}

/** 往主窗口注入背景样式（半透明背景图，内容在上层可读）。 */
function applyBackground() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (bgCssKey) {
    try { mainWindow.webContents.removeInsertedCSS(bgCssKey); } catch { /* ignore */ }
    bgCssKey = null;
  }
  let dataUrl = '';
  try {
    const b64 = fs.readFileSync(backgroundImagePath()).toString('base64');
    dataUrl = `data:image/jpeg;base64,${b64}`;
  } catch { /* 读取失败则用纯色 */ }
  const css = `
    html {
      background-image: url('${dataUrl}') !important;
      background-size: cover !important;
      background-position: center !important;
      background-repeat: no-repeat !important;
    }
    /* 深色模式 */
    body[data-ds-dark-theme] { background-color: rgba(21, 21, 23, 0.72) !important; }
    body[data-ds-dark-theme] [class*="_sidebarCol"] { background-color: rgba(27, 27, 28, 0.80) !important; }
    body[data-ds-dark-theme] [class*="_frame"],
    body[data-ds-dark-theme] [class*="_root"],
    body[data-ds-dark-theme] [class*="_centerCol"],
    body[data-ds-dark-theme] [class*="_scrollBody"] { background-color: transparent !important; }
    /* 浅色模式 */
    body:not([data-ds-dark-theme]) { background-color: rgba(255, 255, 255, 0.75) !important; }
    body:not([data-ds-dark-theme]) [class*="_sidebarCol"] { background-color: rgba(244, 244, 246, 0.85) !important; }
    body:not([data-ds-dark-theme]) [class*="_frame"],
    body:not([data-ds-dark-theme]) [class*="_root"],
    body:not([data-ds-dark-theme]) [class*="_centerCol"],
    body:not([data-ds-dark-theme]) [class*="_scrollBody"] { background-color: transparent !important; }
  `;
  mainWindow.webContents.insertCSS(css).then((key) => { bgCssKey = key; }).catch(() => {});
}

/** 让用户选一张图作为自定义背景。 */
async function chooseBackground() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择背景图片',
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return;
  try {
    fs.copyFileSync(result.filePaths[0], path.join(app.getPath('userData'), 'custom-background.jpg'));
    applyBackground();
    notify(APP_NAME, '背景已更换');
  } catch (err) {
    console.error('[bigfish] 更换背景失败:', err);
  }
}

/** 恢复默认背景。 */
function resetBackground() {
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'custom-background.jpg')); } catch { /* 没有自定义背景 */ }
  applyBackground();
  notify(APP_NAME, '已恢复默认背景');
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏 Bigfish', click: () => toggleMainWindow() },
    { label: '新手向导（设置 API Key）', click: () => createWelcomeWindow() },
    { type: 'separator' },
    { label: '更换背景', click: () => chooseBackground() },
    { label: '恢复默认背景', click: () => resetBackground() },
    { type: 'separator' },
    { label: '桌面萌宠', type: 'checkbox', checked: settings.petEnabled, click: (item) => setPetEnabled(item.checked) },
    { label: '任务完成时通知', type: 'checkbox', checked: settings.notifyOnComplete, click: (item) => setNotify(item.checked) },
    { label: '开机自启', type: 'checkbox', checked: settings.launchAtLogin, click: (item) => setAutoStart(item.checked) },
    { type: 'separator' },
    {
      label: 'Windows 右键菜单',
      submenu: [
        { label: '安装「用 Bigfish 打开」', click: () => installContextMenu() },
        { label: '卸载', click: () => uninstallContextMenu() },
      ],
    },
    { type: 'separator' },
    { label: '检查更新', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: '卸载 Bigfish', click: () => uninstall() },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function setNotify(enabled) {
  settings.notifyOnComplete = enabled;
  saveSettings();
  if (!enabled) { lastBusyAt = 0; notifiedForCycle = false; }
}

function setAutoStart(enabled) {
  settings.launchAtLogin = enabled;
  saveSettings();
  app.setLoginItemSettings({ openAtLogin: enabled });
}

function setPetEnabled(enabled) {
  settings.petEnabled = enabled;
  saveSettings();
  if (enabled) createPetWindow();
  else destroyPetWindow();
}

// ---------------------------------------------------------------------------
// Global shortcut
// ---------------------------------------------------------------------------
function registerShortcuts() {
  const accel = 'CommandOrControl+Shift+D';
  try {
    globalShortcut.register(accel, () => toggleMainWindow());
    console.log(`[bigfish] global shortcut registered: ${accel}`);
  } catch (err) {
    console.error('[bigfish] shortcut register failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Windows "Open with Bigfish" context menu
// ---------------------------------------------------------------------------
function runReg(args) {
  return new Promise((resolve) => {
    const child = spawn('reg', args, { stdio: 'ignore', windowsHide: true });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
}

async function installContextMenu() {
  if (!app.isPackaged) {
    dialog.showMessageBox({ type: 'info', title: APP_NAME, message: '右键菜单只在安装后的版本可用', detail: '请安装打包好的 Bigfish 后再设置右键菜单。' });
    return;
  }
  const exe = process.execPath;
  const cmd = `"${exe}" --open "%1"`;
  const roots = ['HKCU\\Software\\Classes\\*\\shell\\Bigfish', 'HKCU\\Software\\Classes\\Directory\\shell\\Bigfish'];
  for (const r of roots) {
    await runReg(['add', r, '/ve', '/t', 'REG_SZ', '/d', '用 Bigfish 打开', '/f']);
    await runReg(['add', `${r}\\command`, '/ve', '/t', 'REG_SZ', '/d', cmd, '/f']);
    await runReg(['add', r, '/v', 'Icon', '/t', 'REG_SZ', '/d', `${exe},0`, '/f']);
  }
  notify(APP_NAME, '已添加右键「用 Bigfish 打开」');
}

async function uninstallContextMenu() {
  await runReg(['delete', 'HKCU\\Software\\Classes\\*\\shell\\Bigfish', '/f']);
  await runReg(['delete', 'HKCU\\Software\\Classes\\Directory\\shell\\Bigfish', '/f']);
  notify(APP_NAME, '已移除右键菜单');
}

// ---------------------------------------------------------------------------
// --open <path> handling
// ---------------------------------------------------------------------------
function handleOpenArg(argv) {
  const i = argv.indexOf('--open');
  if (i === -1 || !argv[i + 1]) return;
  const target = argv[i + 1];
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  notify(APP_NAME, `已打开: ${target}`);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
    handleOpenArg(argv);
  });

  app.whenReady().then(async () => {
    loadSettings();
    try {
      await startDsh();
      console.log(`[bigfish] backend ready at http://${HOST}:${port}`);
      createWindow();
      console.log('[bigfish] window created');
    } catch (err) {
      // 第一次失败：清理残留后重试一次（常见于上次异常退出导致端口/进程残留）
      try {
        stopDsh();
        cleanupStaleDsh();
        await new Promise((r) => setTimeout(r, 1500));
        await startDsh();
        console.log(`[bigfish] backend ready (retry) at http://${HOST}:${port}`);
        createWindow();
        console.log('[bigfish] window created (retry)');
      } catch (err2) {
        const message = err2 && err2.message ? err2.message : String(err2);
        // 读取后端日志尾部，帮助定位失败原因
        let logTail = '';
        try {
          const content = fs.readFileSync(backendLogPath(), 'utf8');
          logTail = content.split('\n').slice(-15).join('\n').trim();
        } catch { /* 没有日志 */ }
        dialog.showErrorBox(
          APP_NAME,
          `Failed to start the DeepSeek Harness backend:\n\n${message}\n\n` +
          (logTail ? `后端日志（最后几行）：\n${logTail}\n\n` : '') +
          `日志文件：${backendLogPath()}\n\n` +
          `提示：首次启动可能因杀毒软件扫描较慢，可稍等重试；如反复失败，请先在任务管理器结束所有 Bigfish / node 进程后再试。`,
        );
        app.quit();
        return;
      }
    }

    createTray();
    registerShortcuts();
    startCompletionWatcher();
    // 更新检查改为手动：托盘菜单「检查更新」
    if (settings.petEnabled) {
      createPetWindow();
      scheduleWander();
      scheduleSleep();
      schedulePetChatter();
    }
    if (settings.launchAtLogin) setAutoStart(true);
    if (!settings.onboardingDone) createWelcomeWindow();

    handleOpenArg(process.argv);

    app.on('activate', () => {
      ensurePet();
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Live in the tray; do not quit.
  });

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    stopCompletionWatcher();
    stopDsh();
  });

  app.on('will-quit', () => {
    stopDsh();
  });

  // Welcome wizard IPC
  ipcMain.on('welcome-open-url', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.on('welcome-done', () => {
    settings.onboardingDone = true;
    saveSettings();
    if (welcomeWindow && !welcomeWindow.isDestroyed()) welcomeWindow.close();
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  // Pet drag + click
  let petDragStartScreen = null;
  let petDragStartPos = null;
  ipcMain.on('pet-drag-start', (_e, { x, y }) => {
    if (!petWindow) return;
    // 用户开始拖动：立即停掉走动动画，避免瞬移
    if (moveTimer) { clearInterval(moveTimer); moveTimer = null; }
    if (petState === 'walk-left' || petState === 'walk-right') setPetState('idle');
    // 停下后重新安排下一次散步（不阻断后续走动）
    scheduleWander();
    petDragStartScreen = { x, y };
    petDragStartPos = petWindow.getPosition();
  });
  ipcMain.on('pet-drag-move', (_e, { x, y }) => {
    if (!petWindow || !petDragStartScreen || !petDragStartPos) return;
    petWindow.setPosition(
      petDragStartPos[0] + (x - petDragStartScreen.x),
      petDragStartPos[1] + (y - petDragStartScreen.y),
    );
  });
  ipcMain.on('pet-clicked', () => {
    wakePet();
    toggleMainWindow();
    petSay('要我帮忙吗？');
    setPetState('eat');
    clearTimeout(eatTimer);
    eatTimer = setTimeout(() => {
      if (petState === 'eat') setPetState('idle');
    }, 1500);
  });
  ipcMain.on('pet-set-ignore-mouse', (_e, ignore) => {
    // 点击穿透只在 Windows 上可靠；Linux 上一旦开启整条鱼都点不到
    if (process.platform !== 'win32') return;
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });
}
