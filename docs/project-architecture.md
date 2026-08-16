# Bigfish 项目架构梳理（v0.2.0，升级 Electron 41 后）

> 本文基于当前代码（`main.js` 994 行）整理，描述**升级后**的完整技术架构与项目全貌，
> 并与旧版（Electron 33 + 捆绑 Node 时代，v0.1.x）逐项对比。
> 关联文档：`docs/electron-41-upgrade-assessment.md`（升级评估）、`docs/troubleshooting-electron-upgrade.md`（排障记录）。

---

## 1. 项目概览

**Bigfish** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的第三方 Electron 桌面客户端（MIT，非官方）。定位：把 `dsh web` 的本地后端 + React UI 封装进原生桌面应用，让非技术用户**双击即用**，无需命令行、无需记端口、无需开浏览器。

| 维度 | 说明 |
|---|---|
| 目标用户 | 想用 DeepSeek Harness 但不熟悉命令行的普通用户 |
| 核心价值 | 开箱即用（预装 5 个技能）+ 桌面原生体验（托盘/快捷键/桌宠/通知） |
| 技术栈 | Electron 41.10.1 + `@deepseek-ai/dsh@0.1.0-rc.6`（npm 包复用官方后端） |
| 版本 | v0.2.0（2026-08，本次升级） |

---

## 2. 总体架构：双进程模型

```
┌────────────────────────────────────────────────────────────────────┐
│  Electron 主进程  main.js（994 行，应用的总控制器）                  │
│                                                                    │
│  ┌─ 后端生命周期 ────────────────────────────────────────────────┐  │
│  │  找空闲端口 → spawn → 轮询就绪 → 崩溃检测/清理/重试            │  │
│  └───────────────────────────────────────────────────────────────┘  │
│  ┌─ 窗口体系 ── 主窗口(DSH Web UI) / 桌宠窗(透明) / 新手向导窗    ──┐  │
│  ┌─ 系统集成 ── 托盘 / 全局快捷键 / 开机自启 / 右键菜单 / --open  ──┐  │
│  ┌─ 桌面功能 ── 完成通知(启发式) / 背景注入 / 更新检查(手动)      ──┐  │
│  ┌─ 配置持久化 ── settings.json（userData）                       ──┐  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  启动 dsh 子进程：                                                    │
│  spawn(Bigfish.exe --expose-internals bin.js --profile web            │
│        --host 127.0.0.1 --port <空闲端口>,                            │
│        env: ELECTRON_RUN_AS_NODE=1, DSH_HOME=<userData>/dsh-home,     │
│        DSH_BUNDLED_SKILL_DIR=<app>/bundled-skills)                    │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ 仅监听 127.0.0.1（安全边界）
┌──────────────────────────────▼───────────────────────────────────────┐
│  dsh 后端进程（Electron 内置 Node 24.18 的纯 Node 模式）              │
│  · 复用 @deepseek-ai/dsh 官方 npm 包，与命令行版功能完全一致          │
│  · cordis 插件树：base + web-app bundle + 用户 patch 层               │
│  · 预装技能：bundled-skills/（DSH_BUNDLED_SKILL_DIR 加载，优先级最高） │
│  · 独立 DSH_HOME：与用户命令行 dsh 配置完全隔离                       │
└───────────────────────────────────────────────────────────────────────┘
```

**核心思想不变**：桌面版只是官方后端的"壳"，后端能力 100% 来自 `@deepseek-ai/dsh` npm 包；壳层负责原生桌面体验与进程管理。

---

## 3. 进程详解

### 3.1 Electron 主进程（main.js）

| 模块 | 关键函数 | 职责 |
|---|---|---|
| 后端生命周期 | `findFreePort` / `startDsh` / `stopDsh` / `cleanupStaleDsh` / `waitForReady` | 找空闲端口 → 以纯 Node 模式拉起 dsh → 轮询 HTTP 就绪（180s 超时）→ 退出时清理；崩溃残留跨会话清理（Windows 匹配 node.exe 与 Bigfish.exe） |
| 运行时解析 | `resolveRuntime` / `dshHomeOverride` / `dshBinPath` / `bundledSkillDir` | 打包版：`process.execPath` + `ELECTRON_RUN_AS_NODE=1` + `--expose-internals`；开发版：系统 node；DSH_HOME 打包版独立 |
| 窗口体系 | `createWindow` / `createPetWindow` / `createWelcomeWindow` | 主窗口（加载后端 UI，`will-navigate` 白名单防跳转）；桌宠透明窗（点击穿透仅 Windows）；新手向导 |
| 桌宠状态机 | `setPetState` / `scheduleWander` / `scheduleSleep` / `doWander` | idle / eat / sleep / walk-left / walk-right 五状态 + 1.5 分钟随机语录 + 拖动 |
| 系统集成 | `createTray` / `registerShortcuts` / `setAutoStart` / `installContextMenu` | 托盘菜单（含「检查更新」手动项）、`Ctrl+Shift+D` 全局快捷键、开机自启、Windows 右键菜单（reg） |
| 通知 | `notify` / `startCompletionWatcher` | 启发式任务完成检测：监控 DSH_HOME 文件 mtime，30s 空闲判完成 |
| 更新检查 | `checkForUpdates(manual)` | **托盘菜单手动触发**（v0.2 起不再自动），latest.json 版本对比 → 弹窗引导下载 |
| 背景注入 | `applyBackground` / `chooseBackground` / `resetBackground` | 半透明背景图 CSS 注入（深/浅色模式适配）+ 自定义背景 |
| 防御 | 文件顶部 ELECTRON_RUN_AS_NODE 残留检测 | 环境变量残留时给出明确提示而非 TypeError |

### 3.2 dsh 后端进程

启动命令（打包版）：
```
Bigfish.exe --expose-internals <resources>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
            --profile web --host 127.0.0.1 --port <空闲端口>
环境：ELECTRON_RUN_AS_NODE=1, DSH_HOME=<userData>/dsh-home,
      DSH_BUNDLED_SKILL_DIR=<app>/bundled-skills
```

关键点：
- **`ELECTRON_RUN_AS_NODE=1`**：Electron 可执行文件以纯 Node 模式运行（不启动 Chromium/GPU），复用 Electron 41 内置的 **Node 24.18**（满足 dsh 的 `^22.19.0 || >=24.0.0`）——这是去掉捆绑 Node 的基础
- **`--expose-internals`**：必须放在脚本路径前。dsh 的 HMR 服务需要访问 Node internal 模块；Electron 定制 Node 下 `node-addon-require-builtin` 探测失效，此标志让 cordis 走官方 `require('internal/...')` 路径
- **独立 DSH_HOME**（`%APPDATA%\bigfish\dsh-home`）：与命令行 dsh 的 `~/.dsh` 隔离，用户 profile 里的实验性插件（如 link 安装的皮肤）不会拖垮桌面版
- **stdout/stderr 落盘** `backend.log`（userData 下），GUI 无控制台时的诊断通道
- 后端仅监听 `127.0.0.1`（dsh CLI 源码禁止 `0.0.0.0`），外部网络不可达

### 3.3 进程生命周期

```
启动：cleanupStaleDsh（清残留）→ 等 1.5s → findFreePort → spawn → waitForReady
      （成功 → createWindow；失败 → 重试一次 → 弹窗附 backend.log 尾部）
退出：before-quit → 停 watcher / 注销快捷键 / stopDsh（Windows taskkill /T /F，POSIX SIGTERM→SIGKILL）
异常：后端进程提前退出 → Promise.race 立即报错（不再傻等 180s）
```

---

## 4. 窗口体系与安全模型

| 窗口 | 类型 | 加载内容 | webPreferences |
|---|---|---|---|
| 主窗口 | 1280×860 常规 | `http://127.0.0.1:<port>`（DSH Web UI） | sandbox + contextIsolation，无 nodeIntegration |
| 桌宠窗口 | 220×210 透明无边框置顶 | `pet.html` | 同上 + preload（拖动/点击穿透 IPC） |
| 新手向导 | 520×660 模态 | `welcome.html` | 同上 + preload（跳转官网/完成） |

- 所有窗口 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`，渲染层零 Node 权限
- `will-navigate` / `setWindowOpenHandler` 白名单：非 `127.0.0.1:<port>` 的导航一律拦截并交给系统浏览器
- 桌宠点击穿透（`setIgnoreMouseEvents`）仅 Windows 启用（Linux 上会点不到）

---

## 5. 数据与配置

| 数据 | 位置 | 说明 |
|---|---|---|
| 应用设置 | `%APPDATA%\bigfish\settings.json` | 通知开关/开机自启/桌宠开关/引导完成标记 |
| dsh 数据 | `%APPDATA%\bigfish\dsh-home\` | **独立** DSH_HOME：profiles、会话、密钥等（与命令行 dsh 隔离） |
| 后端日志 | `%APPDATA%\bigfish\backend.log` | dsh 子进程 stdout/stderr（追加） |
| 自定义背景 | `%APPDATA%\bigfish\custom-background.jpg` | 托盘「更换背景」写入 |
| API Key | DSH_HOME 内（dsh 管理） | 仅存本地，直连 DeepSeek 官方 API |

---

## 6. 构建与打包

### 6.1 依赖矩阵

| 依赖 | 版本 | 作用 |
|---|---|---|
| electron | `41.10.1`（精确锁定） | 壳层 + 内置 Node 24.18 跑后端 |
| electron-builder | `^24.0.0` | 三平台打包 |
| @deepseek-ai/dsh | `0.1.0-rc.6`（dsh-bundle 独立安装） | 后端本体（纯生产依赖） |
| 原生模块 | node-pty 1.1.0 / koffi / sharp | **全部 N-API**，跨 ABI 通用，无需 rebuild |

### 6.2 打包配置要点（package.json `build`）

- `asar: true`：应用代码/资源归档为单个 `app.asar`（防篡改、减少文件数）；`asarUnpack: ["bundled-skills/**"]` 将预装技能保持真实目录（dsh 子进程为纯 Node 模式，不经过 Electron 的 asar 补丁，必须解包）
- `npmRebuild: false`（N-API 模块无需 rebuild）
- `extraResources`：`dsh-bundle/node_modules` → `resources/dsh/node_modules`（后端依赖进包）
- 图标/版本信息：electron-builder ≥26 内置 `resedit`（纯 JS PE 资源编辑）自动写入，**无需 afterPack 钩子**（旧版依赖 winCodeSign 归档解压，在 Windows 上踩 #8149 符号链接问题，已随 26.x 修复）
- CI（GitHub Actions）：三平台矩阵，node 24，`npm install` + `dsh-bundle npm install --omit=dev` 后直接打包（**无 node-runtime 步骤、无 rebuild 步骤、无打包钩子**）

### 6.3 体积

| 项目 | 旧（v0.1.x） | 新（v0.2.0） |
|---|---|---|
| 安装包 | ~160MB | **~90MB**（-70MB Node 运行时） |
| 运行依赖 | 系统 node + 捆绑 node-runtime | 仅 Electron 自带 Node |

---

## 7. 新旧架构对比

| 维度 | 旧版 v0.1.x（Electron 33） | 新版 v0.2.0（Electron 41） |
|---|---|---|
| Electron / Node | 33.2.0（自带 Node 20.18，不满足 dsh） | **41.10.1（内置 Node 24.18 ✅）** |
| 后端运行方式 | 捆绑独立 Node v24 运行时（node-runtime/） | **ELECTRON_RUN_AS_NODE 复用内置 Node** |
| 捆绑 Node | 有（~70MB） | **无** |
| 原生模块 ABI | 依赖 Node ABI 匹配（node-pty 等） | 全部 N-API，天然兼容 |
| DSH_HOME | 与命令行 dsh 共用 `~/.dsh` | **独立**（userData/dsh-home），配置隔离 |
| 后端诊断 | 无日志，失败只能等超时 | **backend.log 落盘 + 进程退出即时报错** |
| 启动超时 | 90s（傻等） | 180s + 提前退出检测 |
| 更新检查 | 启动 5s 后自动弹窗 | **托盘菜单手动触发** |
| 版本管理 | package.json 0.1.0 / afterPack 硬编码 | **0.2.0，electron-builder 26 自动注入** |
| 残留清理 | 仅匹配 node.exe | 兼容 node.exe + Bigfish.exe |
| 构建链 | 下载/准备 node-runtime + dsh-bundle + 打包钩子 | **仅 dsh-bundle**（CI 少 3 步，无钩子） |
| 维护成本 | 手动跟进 Node 版本、三平台准备运行时 | Node 随 Electron 自动跟进 |
| 兼容层 | — | `--expose-internals`（HMR 兼容定制 Node） |

---

## 8. 目录结构（当前）

```
Bigfish/
├── main.js                  # Electron 主进程（994 行）：后端 + 窗口 + 托盘 + 桌宠 + 通知 + 更新
├── pet.html / pet.js / pet-preload.js    # 桌面萌宠（透明悬浮窗 + 动画 + 点击穿透）
├── welcome.html / welcome.js / welcome-preload.js  # 新手向导
├── make-icons.js            # 图标生成脚本
├── remove-pet-bg.js / update-pet-frames.js  # 萌宠素材工具
├── setup-linux.sh           # Linux 一键准备脚本
├── package.json             # 依赖 + electron-builder 打包配置
├── package-lock.json        # 锁文件（v0.2.0）
├── dsh-bundle/              # 后端生产依赖清单（@deepseek-ai/dsh，本地安装 node_modules）
├── bundled-skills/          # 预装 5 技能：图片识别/PPT/文档总结/写作/翻译
├── build/                   # 图标源 + NSIS 安装器脚本（installer.nsh）
├── assets/                  # 运行时图标 + 萌宠动画帧（pet/）
├── docs/                    # 分享存档 + 升级评估 + 排障记录 + 本文档
└── .github/workflows/build.yml  # CI 三平台打包
```

---

## 9. 安全与隐私

- **不收集任何个人信息**：无遥测、无广告、无第三方统计
- API Key 与对话数据仅存本机（独立 DSH_HOME），直连 DeepSeek 官方 API
- 后端仅监听 `127.0.0.1`；所有渲染窗口沙箱隔离；导航白名单
- 更新检查：GitHub raw 的 latest.json（无签名校验，仅弹窗引导 + openExternal，风险低；已改手动触发）

---

## 10. 已知限制与后续建议

1. **`--open <path>` 与右键菜单「用 Bigfish 打开」是半成品**：目前只唤起窗口 + 通知，未把文件内容交给 AI（可通过 dsh API 注入）
2. **完成通知是启发式**（mtime 轮询），误报/漏报无法完全避免；后续可对接 dsh 官方事件
3. **asar 已开启**（v0.2.0，`bundled-skills` 解包）；后续若 dsh 新增"子进程需直读的应用内资源"，记得同步加入 `asarUnpack`
4. **latest.json 待发布时同步**（v0.2.0 版本 + 新 release URL）
5. 背景图 CSS 注入依赖 DSH UI 类名（`_sidebarCol` 等），**每次 dsh 升级后需目视验证**
6. dsh-bundle 建议提交 `package-lock.json`（当前无锁，依赖版本漂移风险）
